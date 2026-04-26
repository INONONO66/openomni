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

  test("ToolInvoked parses", () => {
    expect(() =>
      AgentExecution.ToolInvoked.schema.parse({
        ...base,
        toolCallId: "tc1",
        toolName: "bash",
        inputSummary: "command: ls",
      }),
    ).not.toThrow();
  });

  test("ToolBlocked parses", () => {
    expect(() =>
      AgentExecution.ToolBlocked.schema.parse({
        ...base,
        toolCallId: "tc1",
        toolName: "bash",
        reason: "denied by policy",
      }),
    ).not.toThrow();
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

  test("ErrorRetry parses", () => {
    expect(() =>
      AgentExecution.ErrorRetry.schema.parse({
        ...base,
        attempt: 2,
        maxAttempts: 3,
        error: "rate limit",
      }),
    ).not.toThrow();
  });
});
