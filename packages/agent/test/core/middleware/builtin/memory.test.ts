import { describe, it, expect, beforeEach } from "bun:test";
import { createMemoryMiddleware } from "../../../../src/core/middleware/builtin/memory";
import type { Memory, MemoryResult } from "../../../../src/core/memory";
import type { MiddlewareContext } from "../../../../src/core/middleware/types";
import { createUserMessage } from "../../../../src/core/message-factory";

describe("createMemoryMiddleware", () => {
  let mockMemory: Memory;
  let ctx: MiddlewareContext;

  beforeEach(() => {
    mockMemory = {
      store: async () => undefined,
      retrieve: async () => [],
      clear: async () => undefined,
    };

    ctx = {
      timing: "pre_turn",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
    };
  });

  it("should inject memory context when results are found", async () => {
    const results: MemoryResult[] = [
      { key: "k1", content: "first memory", score: 0.9 },
      { key: "k2", content: "second memory", score: 0.8 },
    ];

    mockMemory.retrieve = async () => results;

    const middleware = createMemoryMiddleware(mockMemory);
    const userMsg = createUserMessage("what do I know?", "test");
    ctx.messages = [userMsg];

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("transform");
    expect(
      verdict.action === "transform" && (verdict.input as Record<string, unknown>).appendContext,
    ).toBe("[Memory Context]\n- first memory\n- second memory");
  });

  it("should continue when no memory results found", async () => {
    mockMemory.retrieve = async () => [];

    const middleware = createMemoryMiddleware(mockMemory);
    const userMsg = createUserMessage("what do I know?", "test");
    ctx.messages = [userMsg];

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("should continue when no user message in context", async () => {
    mockMemory.retrieve = async () => [{ key: "k1", content: "memory", score: 0.9 }];

    const middleware = createMemoryMiddleware(mockMemory);
    ctx.messages = [];

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("should continue when messages is undefined", async () => {
    mockMemory.retrieve = async () => [{ key: "k1", content: "memory", score: 0.9 }];

    const middleware = createMemoryMiddleware(mockMemory);
    ctx.messages = undefined;

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("should continue when memory.retrieve throws", async () => {
    mockMemory.retrieve = async () => {
      throw new Error("Memory service error");
    };

    const middleware = createMemoryMiddleware(mockMemory);
    const userMsg = createUserMessage("what do I know?", "test");
    ctx.messages = [userMsg];

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("continue");
  });

  it("should have correct middleware registration properties", () => {
    const middleware = createMemoryMiddleware(mockMemory);

    expect(middleware.name).toBe("builtin:memory");
    expect(middleware.timing).toBe("on_system_prompt");
    expect(middleware.priority).toBe(100);
    expect(typeof middleware.fn).toBe("function");
  });

  it("should extract last user message when multiple messages exist", async () => {
    const results: MemoryResult[] = [{ key: "k1", content: "relevant memory", score: 0.95 }];

    mockMemory.retrieve = async (query: string) => {
      // Verify the query is the last user message
      expect(query).toBe("latest question");
      return results;
    };

    const middleware = createMemoryMiddleware(mockMemory);
    const assistantMsg = createUserMessage("first message", "test");
    assistantMsg.info.role = "assistant";
    const userMsg = createUserMessage("latest question", "test");
    ctx.messages = [assistantMsg, userMsg];

    const verdict = await middleware.fn(ctx);

    expect(verdict.action).toBe("transform");
  });
});
