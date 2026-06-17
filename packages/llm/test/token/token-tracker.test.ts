import { describe, expect, it } from "bun:test";
import { TokenTracker } from "../../src/token/index";

describe("TokenTracker.extractUsage", () => {
  it("extracts AI SDK usage format", () => {
    const response = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: {
          noCacheTokens: 90,
          cacheReadTokens: 7,
          cacheWriteTokens: 3,
        },
        outputTokenDetails: {
          textTokens: 44,
          reasoningTokens: 6,
        },
        totalTokens: 150,
      },
    };
    const result = TokenTracker.extractUsage(response);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.reasoningTokens).toBe(6);
    expect(result.cacheReadTokens).toBe(7);
    expect(result.cacheWriteTokens).toBe(3);
  });

  it("extracts Anthropic usage format", () => {
    const response = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        reasoning_tokens: 12,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 3,
      },
    };
    const result = TokenTracker.extractUsage(response);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.reasoningTokens).toBe(12);
    expect(result.cacheWriteTokens).toBe(7);
    expect(result.cacheReadTokens).toBe(3);
  });

  it("extracts OpenAI usage format", () => {
    const response = {
      usage: { prompt_tokens: 200, completion_tokens: 80 },
      providerMetadata: { openai: { reasoningTokens: 9 } },
    };
    const result = TokenTracker.extractUsage(response);
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(80);
    expect(result.reasoningTokens).toBe(9);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
  });

  it("returns zeros when usage is missing", () => {
    const result = TokenTracker.extractUsage({});
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.reasoningTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
  });
});
