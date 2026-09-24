import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Option, TestClock, TestContext } from "effect";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { createExecutionRecord } from "../src/executor-record";
import { createRetryAlarmPort } from "../src/executor-retry-alarm";
import { isolated } from "./helpers/isolated";

import { PolicyDenied } from "../src/errors";
import { Alarm, LedgerAction } from "@openomni/protocol";
import { fixtureHashes } from "./helpers/compiled-policy";
const clock = (): number => 100;

test("execution record emits intents, failures, reverts, and tool observations", () => isolated(Effect.gen(function* () {
  const actions: LedgerAction.Append[] = [];
  let published = 0;
  let id = 0;
  const record = createExecutionRecord({
    ledger: { commit: (action) => Effect.sync(() => {
      actions.push(action);
      return { action: LedgerAction.Node.parse({ ...action, ordinal: actions.length, ...fixtureHashes(actions.length) }), revision: actions.length };
    }) },
    observations: { publish: () => { published += 1; } },
    identity: { sessionId: "record", parentActionId: null, role: "resident" }, clock: (): number => 10, entropy: (): string => `a-${++id}`,
  });
  yield* record.appendIntent({ kind: "tool", op: "run", parentId: null, value: { x: 1 } });
  yield* record.appendFailure({ kind: "tool", op: "run" }, "a-1", { ok: false }, new PolicyDenied({ phase: "pre", ruleIds: [] }));
  yield* record.appendResult({ kind: "tool", op: "run" }, "a-1", { ok: true }, { reverted: true });
  expect(actions).toHaveLength(3);
  const request = { kind: "tool", op: "run", intent: {}, effect: {}, toolObservation: { turnId: "t", callId: "c", timeoutMs: 5 } };
  expect(record.publishToolStarted(request)).toBe(10);
  record.publishToolTerminal(request, 10, "timed_out");
  expect(published).toBe(6);
})));

const schedule = { id: "retry-1", attempt: 1, reason: "transient_error", fireAt: 150 };
const materialize = (id: string) =>
  SessionHandleStore.materialize({
    id,
    role: "resident",
    parentId: null,
    policyGeneration: 1,
    tools: [],
    system: { preset: "", blocks: [] },
    actionId: `${id}:configure`,
    at: clock(),
  });

describe("retry alarm port over the single alarm owner", () => {
  test("arm commits the retry.scheduled row for a live session", () =>
    isolated(
      Effect.gen(function* () {
        yield* materialize("arm-session");
        yield* createRetryAlarmPort("arm-session", clock).arm(schedule);
        expect(Storage.get().alarms?.get("retry-1")).toMatchObject({
          id: "retry-1",
          sessionId: "arm-session",
          kind: "at",
          status: "armed",
          fireAt: 150,
        });
      }),
    ));

  test("a refused arm fails instead of silently continuing, and no row is written", () =>
    isolated(
      Effect.gen(function* () {
        expect(
          yield* Effect.flip(createRetryAlarmPort("missing-session", clock).arm(schedule)),
        ).toMatchObject({
          _tag: "CommitFailed",
          error: { _tag: "AlarmRefused" },
        });
        expect(Storage.get().alarms?.get("retry-1")).toBeUndefined();
      }),
    ));

  test("settle consumes the armed row through the fenced cancel", () =>
    isolated(
      Effect.gen(function* () {
        yield* materialize("settle-session");
        const port = createRetryAlarmPort("settle-session", clock);
        yield* port.arm(schedule);
        yield* port.settle("retry-1");
        expect(Storage.get().alarms?.get("retry-1")).toMatchObject({ status: "cancelled" });
      }),
    ));

  test("wait resolves at the schedule instant", () =>
    isolated(
      Effect.gen(function* () {
        const port = createRetryAlarmPort("wait-session", () => 150);
        yield* port.wait(150, new AbortController().signal);
      }),
    ));

  test("a reconstructed wait uses the residual at execution, never an early wake or a fresh delay", () => isolated(
    Effect.gen(function* () {
      yield* materialize("residual-session");
      yield* createRetryAlarmPort("residual-session", clock).arm(schedule);
      const row = Storage.get().alarms?.get(schedule.id);
      const recorded = Alarm.RetrySchedule.parse(row?.spec?.value);
      let now = 100;
      const entered = Promise.withResolvers<void>();
      const port = createRetryAlarmPort("residual-session", () => { entered.resolve(); return now; });
      const wait = port.wait(recorded.notBefore);
      now = 120;
      const fiber = yield* Effect.forkScoped(wait);
      yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("5 seconds"));
      yield* TestClock.adjust(29);
      expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
      yield* TestClock.adjust(1);
      yield* Fiber.join(fiber);
      expect(Storage.get().alarms?.get(schedule.id)).toEqual(row);
    }).pipe(Effect.provide(TestContext.TestContext)),
  ));

  test("the port fails closed when alarm storage is absent", () =>
    isolated(
      Effect.gen(function* () {
        Storage.reset();
        Storage.configure({ transaction: <T>(operation: () => T): T => operation() });
        expect(yield* Effect.flip(createRetryAlarmPort("s", clock).arm(schedule))).toMatchObject({
          _tag: "CommitFailed",
          error: { _tag: "StorageUnavailable", capability: "alarms" },
        });
      }),
    ));
});
