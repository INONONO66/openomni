import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { createCompactionPolicy } from "../../../../src/core/policy/builtin/compaction";
import type { PolicyContext } from "../../../../src/core/policy";
import type { BudgetState } from "../../../../src/core/budget";
import { effectOf } from "../../../helpers/policy-decision";

function baseCtx(overrides?: Partial<PolicyContext>): PolicyContext {
  return {
    timing: "turn.finish",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function createTestMessage(id: string): Message.WithParts {
  return {
    info: {
      id,
      sessionID: "test-session",
      role: "user",
      time: { created: Date.now() },
      agent: "test-agent",
      model: { providerID: "test", modelID: "test" },
      system: `Test message ${id}`,
    },
    parts: [
      {
        id: `part-${id}`,
        sessionID: "test-session",
        messageID: id,
        type: "text",
        text: `Test message ${id}`,
      },
    ],
  };
}

function budgetState(inputTokens: number, outputTokens: number): BudgetState {
  return {
    startTime: Date.now(),
    turns: 1,
    toolCalls: 0,
    toolRuntimeMs: 0,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
  };
}

describe("createCompactionPolicy", () => {
  it("continues when below threshold", async () => {
    const middleware = createCompactionPolicy({
      contextWindowTokens: 10000,
      thresholdRatio: 0.8,
    });

    const messages = [createTestMessage("msg1"), createTestMessage("msg2")];
    const ctx = baseCtx({
      messages,
      budgetState: budgetState(1000, 500),
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("transforms when above threshold", async () => {
    const middleware = createCompactionPolicy({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
      protectRecentMessages: 2,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      budgetState: budgetState(7000, 1000),
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    const replacement = effectOf(verdict, "run.replace_messages");
    expect(replacement).toBeDefined();
    expect(replacement?.messages.length).toBeLessThan(messages.length);
  });

  it("transforms when reserve budget is reached before ratio threshold", async () => {
    const middleware = createCompactionPolicy({
      contextWindowTokens: 1000,
      thresholdRatio: 0.95,
      reserveTokens: 250,
      protectRecentMessages: 2,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      budgetState: budgetState(700, 60),
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    const replacement = effectOf(verdict, "run.replace_messages");
    expect(replacement).toBeDefined();
    expect(replacement?.messages.length).toBeLessThan(messages.length);
  });

  it("emits compaction event when compacting", async () => {
    const events: Array<{ name: string; data: Record<string, unknown> }> = [];
    const mockEmitter = {
      emit: (name: string, data: Record<string, unknown>) => {
        events.push({ name, data });
      },
    };

    const middleware = createCompactionPolicy({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
      protectRecentMessages: 2,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      budgetState: budgetState(7000, 1000),
      eventEmitter: mockEmitter,
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    expect(events.length).toBe(1);
    const event = events[0];
    if (!event) throw new Error("expected compaction event");
    expect(event.name).toBe("agent.compaction");
    expect(event.data.messagesBefore).toBe(10);
    expect(event.data.messagesAfter).toBeLessThan(10);
  });

  it("continues when no messages in context", async () => {
    const middleware = createCompactionPolicy({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
    });

    const ctx = baseCtx({
      messages: undefined,
      budgetState: budgetState(7000, 1000),
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("continues when empty messages array", async () => {
    const middleware = createCompactionPolicy({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
    });

    const ctx = baseCtx({
      messages: [],
      budgetState: budgetState(7000, 1000),
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("continues when no budget state", async () => {
    const middleware = createCompactionPolicy({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      budgetState: undefined,
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("has priority 900", () => {
    const middleware = createCompactionPolicy({
      contextWindowTokens: 1000,
    });

    expect(middleware.priority).toBe(900);
  });

  it("has name builtin:compaction", () => {
    const middleware = createCompactionPolicy({
      contextWindowTokens: 1000,
    });

    expect(middleware.name).toBe("builtin:compaction");
  });

  it("has timing completion.prepare", () => {
    const middleware = createCompactionPolicy({
      contextWindowTokens: 1000,
    });

    expect(middleware.timing).toBe("completion.prepare");
  });
});
