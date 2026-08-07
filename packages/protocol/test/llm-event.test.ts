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

  test("Completed parses valid token counts", () => {
    expect(
      LlmCall.Completed.schema.parse({
        ...base,
        provider: "openai",
        model: "gpt-4o",
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 50,
        finishReason: "stop",
      }),
    ).toMatchObject({
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("Failed parses and defaults aborted to false", () => {
    const parsed = LlmCall.Failed.schema.parse({
      ...base,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      durationMs: 42,
      error: "No authentication found",
    });

    expect(parsed).toMatchObject({ aborted: false, error: "No authentication found" });
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
