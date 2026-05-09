import { describe, expect, it } from "bun:test";
import type { Message } from "@openomni/protocol";
import { createCompactionMiddleware } from "../../../../src/core/policy/builtin/compaction";
import type { MiddlewareContext } from "../../../../src/core/middleware";

function baseCtx(overrides?: Partial<MiddlewareContext>): MiddlewareContext {
  return {
    timing: "post_turn",
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

describe("createCompactionMiddleware", () => {
  it("continues when below threshold", async () => {
    const middleware = createCompactionMiddleware({
      contextWindowTokens: 10000,
      thresholdRatio: 0.8,
    });

    const messages = [createTestMessage("msg1"), createTestMessage("msg2")];
    const ctx = baseCtx({
      messages,
      budgetState: { turns: 1, totalInputTokens: 1000, totalOutputTokens: 500 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("transforms when above threshold", async () => {
    const middleware = createCompactionMiddleware({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
      protectRecentMessages: 2,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      budgetState: { turns: 1, totalInputTokens: 7000, totalOutputTokens: 1000 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("transform");
    const v = verdict as Record<string, unknown>;
    expect(v.input).toBeDefined();
    expect((v.input as Record<string, unknown>).messages).toBeDefined();
    expect(((v.input as Record<string, unknown>).messages as unknown[]).length).toBeLessThan(
      messages.length,
    );
  });

  it("emits compaction event when compacting", async () => {
    const events: Array<{ name: string; data: unknown }> = [];
    const mockEmitter = {
      emit: (name: string, data: unknown) => {
        events.push({ name, data });
      },
    };

    const middleware = createCompactionMiddleware({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
      protectRecentMessages: 2,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      budgetState: { turns: 1, totalInputTokens: 7000, totalOutputTokens: 1000 },
      eventEmitter: mockEmitter as unknown as Parameters<typeof baseCtx>[0]["eventEmitter"],
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("transform");
    expect(events.length).toBe(1);
    expect(events[0].name).toBe("agent.compaction");
    expect(events[0].data.messagesBefore).toBe(10);
    expect(events[0].data.messagesAfter).toBeLessThan(10);
  });

  it("continues when no messages in context", async () => {
    const middleware = createCompactionMiddleware({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
    });

    const ctx = baseCtx({
      messages: undefined,
      budgetState: { turns: 1, totalInputTokens: 7000, totalOutputTokens: 1000 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("continues when empty messages array", async () => {
    const middleware = createCompactionMiddleware({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
    });

    const ctx = baseCtx({
      messages: [],
      budgetState: { turns: 1, totalInputTokens: 7000, totalOutputTokens: 1000 },
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("continues when no budget state", async () => {
    const middleware = createCompactionMiddleware({
      contextWindowTokens: 1000,
      thresholdRatio: 0.8,
    });

    const messages = Array.from({ length: 10 }, (_, i) => createTestMessage(`msg${i}`));
    const ctx = baseCtx({
      messages,
      budgetState: undefined,
    });

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("has priority 900", () => {
    const middleware = createCompactionMiddleware({
      contextWindowTokens: 1000,
    });

    expect(middleware.priority).toBe(900);
  });

  it("has name builtin:compaction", () => {
    const middleware = createCompactionMiddleware({
      contextWindowTokens: 1000,
    });

    expect(middleware.name).toBe("builtin:compaction");
  });

  it("has timing post_compaction", () => {
    const middleware = createCompactionMiddleware({
      contextWindowTokens: 1000,
    });

    expect(middleware.timing).toBe("post_compaction");
  });
});
