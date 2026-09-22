import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SessionHandleStore, Storage } from "@openomni/ledger";
import { createRetryAlarmPort } from "../src/executor-retry-alarm";
import { isolated } from "./helpers/isolated";

const clock = () => 100;
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
