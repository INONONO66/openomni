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
