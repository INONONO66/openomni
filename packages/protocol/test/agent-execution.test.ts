import { describe, expect, test } from "bun:test";
import { Run } from "../src/run/index.js";

describe("Run.Events BusEvents", () => {
  const base = { traceId: "test-trace-id", sessionId: "s1", time: Date.now() };

  test("TurnStart parses", () => {
    expect(() => Run.Events.TurnStart.schema.parse({ ...base, turnIndex: 0 })).not.toThrow();
  });

  test("TurnComplete parses", () => {
    expect(() =>
      Run.Events.TurnComplete.schema.parse({
        ...base,
        turnIndex: 0,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    ).not.toThrow();
  });

  test("TurnComplete requires total usage", () => {
    expect(() =>
      Run.Events.TurnComplete.schema.parse({
        ...base,
        turnIndex: 0,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ).toThrow();
  });

  test("tool execution events are not duplicated under Run.Events", () => {
    expect("ToolInvoked" in Run.Events).toBe(false);
    expect("ToolBlocked" in Run.Events).toBe(false);
  });

  test("BudgetWarning parses", () => {
    expect(() =>
      Run.Events.BudgetWarning.schema.parse({
        ...base,
        remaining: "5 turns remaining",
        threshold: 0.8,
      }),
    ).not.toThrow();
  });

  test("BudgetReassurance parses", () => {
    expect(() =>
      Run.Events.BudgetReassurance.schema.parse({
        ...base,
        remaining: "15 turns remaining",
        threshold: 0.6,
      }),
    ).not.toThrow();
  });

  test("Compaction parses", () => {
    expect(() =>
      Run.Events.Compaction.schema.parse({
        ...base,
        messagesBefore: 20,
        messagesAfter: 5,
      }),
    ).not.toThrow();
  });

  test("CompactionStarted parses, with and without measurement", () => {
    expect(() =>
      Run.Events.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        contextTokens: 180_000,
        trigger: "threshold",
        summarizer: false,
      }),
    ).not.toThrow();
    expect(() =>
      Run.Events.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        trigger: "yield",
        summarizer: true,
      }),
    ).not.toThrow();
  });

  test("CompactionStarted rejects an unknown trigger", () => {
    expect(() =>
      Run.Events.CompactionStarted.schema.parse({
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
        Run.Events.CompactionCompleted.schema.parse({
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
      Run.Events.CompactionCompleted.schema.parse({
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

    expect(() => Run.Events.ErrorRetry.schema.parse(payload)).toThrow();
  });

  test("ErrorRetry parses", () => {
    expect(() =>
      Run.Events.ErrorRetry.schema.parse({
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
