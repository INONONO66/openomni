import { describe, it, expect, beforeEach } from "bun:test";
import { createMemoryPolicy } from "../../../../src/core/policy/builtin/memory";
import type { Memory, MemoryResult } from "../../../../src/core/memory";
import type { PolicyContext } from "../../../../src/core/policy/types";
import { createUserMessage } from "../../../../src/core/message-factory";

describe("createMemoryPolicy", () => {
  let mockMemory: Memory;
  let ctx: PolicyContext;

  beforeEach(() => {
    mockMemory = {
      store: async () => undefined,
      retrieve: async () => [],
      clear: async () => undefined,
    };

    ctx = {
      timing: "turn.start",
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

    const middleware = createMemoryPolicy(mockMemory);
    const userMsg = createUserMessage("what do I know?", "test");
    ctx.messages = [userMsg];

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
    expect(verdict.effects).toContainEqual({
      type: "prompt.append_context",
      context: "[Memory Context]\n- first memory\n- second memory",
    });
  });

  it("should continue when no memory results found", async () => {
    mockMemory.retrieve = async () => [];

    const middleware = createMemoryPolicy(mockMemory);
    const userMsg = createUserMessage("what do I know?", "test");
    ctx.messages = [userMsg];

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("should continue when no user message in context", async () => {
    mockMemory.retrieve = async () => [{ key: "k1", content: "memory", score: 0.9 }];

    const middleware = createMemoryPolicy(mockMemory);
    ctx.messages = [];

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("should continue when messages is undefined", async () => {
    mockMemory.retrieve = async () => [{ key: "k1", content: "memory", score: 0.9 }];

    const middleware = createMemoryPolicy(mockMemory);
    ctx.messages = undefined;

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("should continue when memory.retrieve throws", async () => {
    mockMemory.retrieve = async () => {
      throw new Error("Memory service error");
    };

    const middleware = createMemoryPolicy(mockMemory);
    const userMsg = createUserMessage("what do I know?", "test");
    ctx.messages = [userMsg];

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });

  it("should have correct middleware registration properties", () => {
    const middleware = createMemoryPolicy(mockMemory);

    expect(middleware.name).toBe("builtin:memory");
    expect(middleware.timing).toBe("context.prepare");
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

    const middleware = createMemoryPolicy(mockMemory);
    const assistantMsg = createUserMessage("first message", "test");
    assistantMsg.info.role = "assistant";
    const userMsg = createUserMessage("latest question", "test");
    ctx.messages = [assistantMsg, userMsg];

    const verdict = await middleware.fn(ctx);

    expect(verdict.verdict).toBe("allow");
  });
});
