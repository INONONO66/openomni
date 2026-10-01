import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Option } from "effect";
import { runAgent } from "../helpers/executor";
import { TestClock } from "effect/testing";
import { CommitRefused } from "@openomni/ledger";
import { sessionTree as kernelSessionTree } from "../helpers/session-tree";
import { Alarm, LedgerAction, type SessionTransition } from "@openomni/protocol";
import { CommitFailed } from "../../src/errors";
import type { ExecutorOptions } from "../../src/executor-contract";
import { commitSessionRequest } from "../../src/session-admission";
import {
  createRetryTimerPort,
  deadlineDelivery,
  retryDelivery,
  watchFiredDelivery,
  watchTimeoutDelivery,
  watchTimeoutKey,
  type TimerChainReads,
} from "../../src/cluster/timers";
import { fixtureHashes } from "../helpers/compiled-policy";
import { memoryExecutionReads } from "../helpers/execution-reads";
import { requestLedger } from "../helpers/g0-request-ledger";
import { isolated, isolatedLedger } from "../helpers/isolated";
import { pendingRequest } from "../helpers/open-request";
import { allowConfigure, isolatedRuntime } from "../helpers/session-services";

/** Chain oracle over the active isolation's kernel. */
const sessionTree = (sessionId: string) => kernelSessionTree(isolatedLedger().kernel, sessionId);

// Type-level drop-in proof: the timer port replaces the alarm-table port.
type RetryPortSlot = NonNullable<ExecutorOptions["retryAlarm"]>;
const _dropIn: RetryPortSlot = createRetryTimerPort({
  commitScheduled: () => Effect.void,
  send: () => Effect.void,
  clock: () => 0,
});
void _dropIn;

const action = (input: {
  id: string;
  parentId: string | null;
  sessionId: string;
  kind: LedgerAction.Append["kind"];
}): LedgerAction.Append => ({
  id: input.id,
  parentId: input.parentId,
  sessionId: input.sessionId,
  kind: input.kind,
  intent: { encodingVersion: 1, value: { phase: "intent" } },
  effect: { encodingVersion: 1, value: { phase: "pending" } },
  ts: 100,
  irreversible: true,
});

/** The kernel read ports a timer delivery consults (the isolation's kernel instance). */
const chainReads = (sessionId: string): TimerChainReads => {
  const kernel = isolatedLedger().kernel;
  return {
    actionById: kernel.actionById,
    requestById: kernel.requestById,
    resultFor: (id) => kernel.resultFor(sessionId, id),
    operationChildrenPage: (id, cursor) => kernel.operationChildrenPage(sessionId, id, cursor),
  };
};

describe("retry delivery chain guard", () => {
  test("re-runs only the live unsettled attempt; settled or superseded deliveries no-op", () =>
    isolated(
      Effect.gen(function* () {
        const id = "timers-retry";
        const fixture = yield* requestLedger({ id });
        const reads = chainReads(id);
        const operation = `${id}:llm`;
        const attempt = `${operation}:attempt:1`;
        yield* fixture.ledger.commit(
          action({ id: operation, parentId: fixture.identity.turnId, sessionId: id, kind: "llm" }),
        );
        yield* fixture.ledger.commit(
          action({ id: attempt, parentId: operation, sessionId: id, kind: "attempt" }),
        );

        expect(retryDelivery(reads, `${attempt}:retry:1`)).toEqual({ op: "run" });
        expect(retryDelivery(reads, "no-separator")).toEqual({
          op: "skip",
          reason: "malformed_alarm_id",
        });
        expect(retryDelivery(reads, "missing:retry:1")).toEqual({
          op: "skip",
          reason: "unknown_attempt",
        });

        // A newer attempt intent wins over the redelivered rearm.
        yield* fixture.ledger.commit(
          action({
            id: `${operation}:attempt:2`,
            parentId: operation,
            sessionId: id,
            kind: "attempt",
          }),
        );
        expect(retryDelivery(reads, `${attempt}:retry:1`)).toEqual({
          op: "skip",
          reason: "superseded",
        });

        // A settled attempt never re-runs.
        yield* fixture.ledger.commit({
          id: `${attempt}:result`,
          parentId: attempt,
          sessionId: id,
          kind: "attempt",
          intent: { encodingVersion: 1, value: { phase: "result" } },
          effect: { encodingVersion: 1, value: { phase: "result", terminal: "failed" } },
          ts: 101,
          irreversible: true,
        });
        expect(retryDelivery(reads, `${attempt}:retry:1`)).toEqual({
          op: "skip",
          reason: "attempt_settled",
        });

        // Guards are pure chain reads: no rows were produced by any skip.
        const before = sessionTree(id).length;
        retryDelivery(reads, `${attempt}:retry:1`);
        expect(sessionTree(id)).toHaveLength(before);
      }),
    ));

  test("supersede detection pages past a full 256-child window", () => {
    const node = (
      id: string,
      parentId: string | null,
      kind: LedgerAction.Append["kind"],
      ordinal: number,
    ) =>
      LedgerAction.Node.parse({
        ...action({ id, parentId, sessionId: "paging", kind }),
        ordinal,
        ...fixtureHashes(ordinal),
      });
    const nodes = [
      node("op", null, "llm", 1),
      node("op:attempt:1", "op", "attempt", 2),
      ...Array.from({ length: 256 }, (_, index) =>
        node(`op:tool:${index}`, "op", "tool", 3 + index),
      ),
      node("op:attempt:2", "op", "attempt", 259),
    ];
    const memory = memoryExecutionReads(() => nodes);
    const reads: TimerChainReads = {
      actionById: (id) => memory.actionById?.(id),
      requestById: (id) => memory.requestById?.(id),
      resultFor: (id) => memory.resultFor?.(id),
      operationChildrenPage: (id, cursor) => memory.operationChildrenPage?.(id, cursor) ?? [],
    };
    expect(retryDelivery(reads, "op:attempt:1:retry:1")).toEqual({
      op: "skip",
      reason: "superseded",
    });
    expect(retryDelivery(reads, "op:attempt:2:retry:1")).toEqual({ op: "run" });
  });
});

function approvalAnswer(
  request: SessionTransition.Request,
  inputId: string,
  receivedAt: number,
): SessionTransition.Answer {
  return {
    inputId,
    requestId: request.requestId,
    sessionId: request.sessionId,
    receivedAt,
    principal: { kind: "owner", principalId: "owner", evidenceId: inputId },
    bindingDigest: request.bindingDigest,
    inputHash: request.inputHash,
    effectHash: request.effectHash,
    generation: request.generation,
    toolsHash: request.toolsHash,
    domainRevisions: request.domainRevisions,
    decision: "approve",
    allowedAction: "report_result",
    content: "approved",
  };
}

const openApproval = (id: string, deadline: number) =>
  Effect.gen(function* () {
    const request = yield* pendingRequest(id, deadline);
    const transition = (payload: SessionTransition.Payload, inputId: string, at: number) =>
      commitSessionRequest(isolatedLedger().kernel, id, { owner: `${id}:owner`, fence: 1 }, payload, inputId, at, {
        authorizeConfigure: allowConfigure,
        ...isolatedRuntime(),
      });
    const opened = yield* transition({ kind: "request.open", request }, `${id}:open`, 100);
    expect(opened.resolution).toBe("opened");
    return { request, transition };
  });

describe("deadline delivery chain guard", () => {
  test("expires an open request once; late answers keep the late_unknown token", () =>
    isolated(
      Effect.gen(function* () {
        const id = "timers-deadline";
        const reads = chainReads(id);
        const { request, transition } = yield* openApproval(id, 1000);

        expect(deadlineDelivery(reads, request.requestId)).toEqual({ op: "run" });
        const expired = yield* transition(
          { kind: "request.timeout", requestId: request.requestId },
          `${id}:timeout`,
          1000,
        );
        expect(expired.resolution).toBe("expired");
        expect(isolatedLedger().kernel.requestById(request.requestId)?.state).toBe("expired");

        // Redelivered deadline acks without committing anything.
        const before = sessionTree(id).length;
        expect(deadlineDelivery(reads, request.requestId)).toEqual({
          op: "skip",
          reason: "request_terminal",
        });
        expect(sessionTree(id)).toHaveLength(before);
        expect(deadlineDelivery(reads, "missing-request")).toEqual({
          op: "skip",
          reason: "unknown_request",
        });

        // A resolve arriving after expiry keeps the request-plane token.
        const late = yield* transition(
          { kind: "request.answer", answer: approvalAnswer(request, `${id}:late`, 1200) },
          `${id}:late`,
          1200,
        );
        expect(late.resolution).toBe("late_unknown");
      }),
    ));

  test("a deadline after RequestResolve no-ops and duplicates stay duplicates", () =>
    isolated(
      Effect.gen(function* () {
        const id = "timers-resolved";
        const reads = chainReads(id);
        const { request, transition } = yield* openApproval(id, 1000);

        const resolved = yield* transition(
          { kind: "request.answer", answer: approvalAnswer(request, `${id}:answer`, 100) },
          `${id}:answer`,
          100,
        );
        expect(resolved.resolution).toBe("resolved");
        expect(deadlineDelivery(reads, request.requestId)).toEqual({
          op: "skip",
          reason: "request_terminal",
        });

        const duplicate = yield* transition(
          { kind: "request.timeout", requestId: request.requestId },
          `${id}:timeout`,
          1000,
        );
        expect(duplicate.resolution).toBe("duplicate");
      }),
    ));
});

describe("watch delivery chain guards", () => {
  test("occurrence and timeout deliveries dedupe on committed chain keys", () =>
    isolated(
      Effect.gen(function* () {
        const id = "timers-watch";
        const fixture = yield* requestLedger({ id });
        const reads = chainReads(id);
        const occurrence = Alarm.occurrenceId("watch-1", 1, "line:1:1");
        const timeout = { watchId: "watch-1", epoch: 1 };

        expect(watchFiredDelivery(reads, occurrence)).toEqual({ op: "run" });
        expect(watchTimeoutDelivery(reads, timeout)).toEqual({ op: "run" });

        yield* fixture.ledger.commit(
          action({
            id: occurrence,
            parentId: fixture.identity.turnId,
            sessionId: id,
            kind: "alarm.fired",
          }),
        );
        yield* fixture.ledger.commit(
          action({
            id: watchTimeoutKey(timeout),
            parentId: fixture.identity.turnId,
            sessionId: id,
            kind: "alarm.fired",
          }),
        );

        const before = sessionTree(id).length;
        expect(watchFiredDelivery(reads, occurrence)).toEqual({
          op: "skip",
          reason: "duplicate_occurrence",
        });
        expect(watchTimeoutDelivery(reads, timeout)).toEqual({
          op: "skip",
          reason: "duplicate_timeout",
        });
        // A different epoch is a fresh arm, never deduped against the old one.
        expect(watchTimeoutDelivery(reads, { watchId: "watch-1", epoch: 2 })).toEqual({
          op: "run",
        });
        expect(sessionTree(id)).toHaveLength(before);
      }),
    ));
});

describe("retry timer port over DeliverAt", () => {
  const schedule = { id: "attempt-1:retry:1", attempt: 1, reason: "transient_error", fireAt: 150 };

  test("arm persists chain evidence strictly before the rearm message", () =>
    runAgent(
      Effect.gen(function* () {
        const order: string[] = [];
        const port = createRetryTimerPort({
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
        const port = createRetryTimerPort({
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
        const port = createRetryTimerPort({
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
        const port = createRetryTimerPort({
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
        const port = createRetryTimerPort({
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
