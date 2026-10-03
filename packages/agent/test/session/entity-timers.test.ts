import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Option } from "effect";
import { runAgent } from "../helpers/executor";
import { TestClock } from "effect/testing";
import { CommitRefused } from "../../src/core/store/errors";
import { CommitFailed } from "../../src/core/failure";
import type { ExecutorOptions } from "../../src/core/gate/decide";
import { createRetryAlarmPort } from "../../src/core/alarm";

// Type-level drop-in proof: the timer port replaces the alarm-table port.
type RetryPortSlot = NonNullable<ExecutorOptions["retryAlarm"]>;
const _dropIn: RetryPortSlot = createRetryAlarmPort({
  commitScheduled: () => Effect.void,
  send: () => Effect.void,
  clock: () => 0,
});
void _dropIn;

describe("retry timer port over DeliverAt", () => {
  const schedule = { id: "attempt-1:retry:1", attempt: 1, reason: "transient_error", fireAt: 150 };

  test("arm persists chain evidence strictly before the rearm message", () =>
    runAgent(
      Effect.gen(function* () {
        const order: string[] = [];
        const port = createRetryAlarmPort({
          commitScheduled: (input) =>
            Effect.sync(() => {
              order.push(`commit:${input.id}:${input.notBefore}`);
            }),
          send: (message) =>
            Effect.sync(() => {
              order.push(`send:${message.alarmId}:${message.notBefore}`);
            }),
          clock: () => 100,
        });
        yield* port.arm(schedule);
        expect(order).toEqual(["commit:attempt-1:retry:1:150", "send:attempt-1:retry:1:150"]);
      }),
    ));

  test("a refused chain commit fails the arm and never sends the rearm", () =>
    runAgent(
      Effect.gen(function* () {
        let sent = 0;
        const refusal = new CommitFailed({
          error: new CommitRefused({
            sessionId: "s",
            reason: "revision",
            expectedRevision: 0,
            currentRevision: 1,
            fence: 1,
            currentFence: 1,
          }),
        });
        const port = createRetryAlarmPort({
          commitScheduled: () => Effect.fail(refusal),
          send: () =>
            Effect.sync(() => {
              sent += 1;
            }),
          clock: () => 100,
        });
        expect(yield* Effect.flip(port.arm(schedule))).toBe(refusal);
        expect(sent).toBe(0);
      }),
    ));

  test("settle is a no-op: supersede is decided at delivery, never as a cancel", () =>
    runAgent(
      Effect.gen(function* () {
        let sent = 0;
        const port = createRetryAlarmPort({
          commitScheduled: () => Effect.void,
          send: () =>
            Effect.sync(() => {
              sent += 1;
            }),
          clock: () => 100,
        });
        yield* port.settle(schedule.id);
        expect(sent).toBe(0);
      }),
    ));

  test("wait sleeps exactly the residual and resolves immediately when due", () =>
    runAgent(
      Effect.gen(function* () {
        let now = 100;
        const port = createRetryAlarmPort({
          commitScheduled: () => Effect.void,
          send: () => Effect.void,
          clock: () => now,
        });
        yield* port.wait(100);
        now = 120;
        const fiber = yield* Effect.forkScoped(port.wait(150));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(29);
        expect(Option.isNone(Option.fromUndefinedOr(fiber.pollUnsafe()))).toBe(true);
        yield* TestClock.adjust(1);
        yield* Fiber.join(fiber);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
    ));

  test("an aborted signal interrupts the residual wait", () =>
    runAgent(
      Effect.gen(function* () {
        const port = createRetryAlarmPort({
          commitScheduled: () => Effect.void,
          send: () => Effect.void,
          clock: () => 100,
        });
        const controller = new AbortController();
        const fiber = yield* Effect.forkScoped(port.wait(100_000, controller.signal));
        yield* Effect.yieldNow;
        controller.abort();
        const exit = yield* Fiber.await(fiber);
        expect(exit._tag).toBe("Failure");
      }).pipe(Effect.scoped),
    ));
});
