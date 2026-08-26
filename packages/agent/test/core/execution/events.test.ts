import { describe, expect, test } from "bun:test";
import { RunEvents } from "../../../src/core/execution/events";

// #500 C1: moved from packages/protocol/test/agent-execution.test.ts — the
// descriptors live in this package now (src/core/execution/events.ts); the
// persisted `agent.*` name strings stay frozen.
describe("RunEvents BusEvents", () => {
  const base = { traceId: "test-trace-id", sessionId: "s1", time: Date.now() };

  test("TurnStart parses", () => {
    expect(() => RunEvents.TurnStart.schema.parse({ ...base, turnIndex: 0 })).not.toThrow();
  });

  // The run loop publishes every event with `actorId` in the payload
  // (run.ts `agentBase`); the persisted schema must keep it, or audit
  // attribution is stripped on parse.
  test("published run events round-trip actorId through the schema", () => {
    const actorId = "run-actor-1";
    const parsed = RunEvents.TurnStart.schema.parse({ ...base, actorId, turnIndex: 0 });
    expect(parsed.actorId).toBe(actorId);

    const retried = RunEvents.ErrorRetry.schema.parse({
      ...base,
      actorId,
      attempt: 2,
      maxAttempts: 3,
      error: "rate limit",
      reason: "transient_error",
      backoffMs: 2000,
    });
    expect(retried.actorId).toBe(actorId);
  });

  test("TurnComplete parses", () => {
    expect(() =>
      RunEvents.TurnComplete.schema.parse({
        ...base,
        turnIndex: 0,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    ).not.toThrow();
  });

  test("TurnComplete requires total usage", () => {
    expect(() =>
      RunEvents.TurnComplete.schema.parse({
        ...base,
        turnIndex: 0,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ).toThrow();
  });

  test("tool execution events are not duplicated under RunEvents", () => {
    expect("ToolInvoked" in RunEvents).toBe(false);
    expect("ToolBlocked" in RunEvents).toBe(false);
  });

  test("BudgetWarning parses", () => {
    expect(() =>
      RunEvents.BudgetWarning.schema.parse({
        ...base,
        remaining: "5 turns remaining",
        threshold: 0.8,
      }),
    ).not.toThrow();
  });

  test("BudgetReassurance parses", () => {
    expect(() =>
      RunEvents.BudgetReassurance.schema.parse({
        ...base,
        remaining: "15 turns remaining",
        threshold: 0.6,
      }),
    ).not.toThrow();
  });

  test("CompactionStarted parses, with and without measurement", () => {
    expect(() =>
      RunEvents.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        contextTokens: 180_000,
        trigger: "threshold",
        summarizer: false,
      }),
    ).not.toThrow();
    expect(() =>
      RunEvents.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        trigger: "yield",
        summarizer: true,
      }),
    ).not.toThrow();
  });

  test("CompactionStarted rejects an unknown trigger", () => {
    expect(() =>
      RunEvents.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        trigger: "manual",
        summarizer: false,
      }),
    ).toThrow();
  });

  test("CompactionCompleted parses every outcome; rejects unknown ones", () => {
    for (const outcome of [
      "cut",
      "reduced",
      "nothing_reclaimed",
      "no_user_boundary",
      "failed",
    ] as const) {
      expect(() =>
        RunEvents.CompactionCompleted.schema.parse({
          ...base,
          outcome,
          messagesBefore: 20,
          messagesAfter: 5,
          removedCount: 15,
          elidedChars: 0,
        }),
      ).not.toThrow();
    }
    expect(() =>
      RunEvents.CompactionCompleted.schema.parse({
        ...base,
        outcome: "partial",
        messagesBefore: 20,
        messagesAfter: 5,
        removedCount: 15,
        elidedChars: 0,
      }),
    ).toThrow();
  });

  /** One field at a time, or relaxing either alone still throws on the other. */
  test.each(["reason", "backoffMs"] as const)("ErrorRetry requires %s", (field) => {
    const payload: Record<string, unknown> = {
      ...base,
      attempt: 2,
      maxAttempts: 3,
      error: "rate limit",
      reason: "transient_error",
      backoffMs: 2000,
    };
    delete payload[field];

    expect(() => RunEvents.ErrorRetry.schema.parse(payload)).toThrow();
  });

  test("ErrorRetry parses", () => {
    expect(() =>
      RunEvents.ErrorRetry.schema.parse({
        ...base,
        attempt: 2,
        maxAttempts: 3,
        error: "rate limit",
        reason: "transient_error",
        backoffMs: 2000,
      }),
    ).not.toThrow();
  });
});
