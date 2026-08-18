import { describe, expect, test } from "bun:test";
import { AgentExecution } from "../src/event/agent-execution.js";

describe("AgentExecution BusEvents", () => {
  const base = { traceId: "test-trace-id", sessionId: "s1", time: Date.now() };

  test("TurnStart parses", () => {
    expect(() => AgentExecution.TurnStart.schema.parse({ ...base, turnIndex: 0 })).not.toThrow();
  });

  test("TurnComplete parses", () => {
    expect(() =>
      AgentExecution.TurnComplete.schema.parse({
        ...base,
        turnIndex: 0,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      }),
    ).not.toThrow();
  });

  test("TurnComplete requires total usage", () => {
    expect(() =>
      AgentExecution.TurnComplete.schema.parse({
        ...base,
        turnIndex: 0,
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    ).toThrow();
  });

  test("tool execution events are not duplicated under AgentExecution", () => {
    expect("ToolInvoked" in AgentExecution).toBe(false);
    expect("ToolBlocked" in AgentExecution).toBe(false);
  });

  test("BudgetWarning parses", () => {
    expect(() =>
      AgentExecution.BudgetWarning.schema.parse({
        ...base,
        remaining: "5 turns remaining",
        threshold: 0.8,
      }),
    ).not.toThrow();
  });

  test("BudgetReassurance parses", () => {
    expect(() =>
      AgentExecution.BudgetReassurance.schema.parse({
        ...base,
        remaining: "15 turns remaining",
        threshold: 0.6,
      }),
    ).not.toThrow();
  });

  test("Compaction parses", () => {
    expect(() =>
      AgentExecution.Compaction.schema.parse({
        ...base,
        messagesBefore: 20,
        messagesAfter: 5,
      }),
    ).not.toThrow();
  });

  test("CompactionStarted parses, with and without measurement", () => {
    expect(() =>
      AgentExecution.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        contextTokens: 180_000,
        trigger: "threshold",
        summarizer: false,
      }),
    ).not.toThrow();
    expect(() =>
      AgentExecution.CompactionStarted.schema.parse({
        ...base,
        messagesBefore: 20,
        trigger: "yield",
        summarizer: true,
      }),
    ).not.toThrow();
  });

  test("CompactionStarted rejects an unknown trigger", () => {
    expect(() =>
      AgentExecution.CompactionStarted.schema.parse({
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
        AgentExecution.CompactionCompleted.schema.parse({
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
      AgentExecution.CompactionCompleted.schema.parse({
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

    expect(() => AgentExecution.ErrorRetry.schema.parse(payload)).toThrow();
  });

  test("ErrorRetry parses", () => {
    expect(() =>
      AgentExecution.ErrorRetry.schema.parse({
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
