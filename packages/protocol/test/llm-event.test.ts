import { describe, expect, test } from "bun:test";
import { LlmCall } from "../src/event/llm.js";

describe("LlmCall BusEvents", () => {
  const base = { traceId: "test-trace-id", sessionId: "s1", time: Date.now() };

  function parseCompleted(input: unknown): unknown {
    return LlmCall.Completed.schema.parse(input);
  }

  function completedParseFails(input: unknown): boolean {
    try {
      parseCompleted(input);
      return false;
    } catch {
      return true;
    }
  }

  test("Completed refuses missing token lanes — the producer states them", () => {
    const completed = {
      ...base,
      provider: "openai",
      model: "gpt-4o",
      durationMs: 100,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 3,
      finishReason: "stop",
    };
    expect(LlmCall.Completed.schema.parse(completed)).toMatchObject({
      reasoningTokens: 7,
      cacheReadTokens: 90,
      cacheWriteTokens: 3,
    });
    // Pin: a defaulted zero is indistinguishable from "provider reported no
    // reasoning tokens" — a producer that drops a lane must fail, not zero.
    const { reasoningTokens: _r, ...missing } = completed;
    expect(LlmCall.Completed.schema.safeParse(missing).success).toBe(false);
    expect(LlmCall.Completed.name).toBe("llm.call.completed");
  });

  test("Failed refuses a missing aborted flag — false is load-bearing", () => {
    const failed = {
      ...base,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      durationMs: 42,
      error: "No authentication found",
    };
    // Pin: a dropped field must not silently read as "genuine error".
    expect(LlmCall.Failed.schema.safeParse(failed).success).toBe(false);
    expect(LlmCall.Failed.schema.parse({ ...failed, aborted: true })).toMatchObject({
      aborted: true,
    });
    expect(LlmCall.Failed.name).toBe("llm.call.failed");
  });

  test("Completed rejects negative and fractional token counts", () => {
    const valid = {
      ...base,
      provider: "openai",
      model: "gpt-4o",
      durationMs: 100,
      outputTokens: 50,
      finishReason: "stop",
    };

    expect(completedParseFails({ ...valid, inputTokens: -1 })).toBe(true);
    expect(completedParseFails({ ...valid, inputTokens: 1.5 })).toBe(true);
  });
});
