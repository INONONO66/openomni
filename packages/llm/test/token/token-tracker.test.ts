import { describe, expect, it, spyOn } from "bun:test";
import { TokenTracker } from "../../src/token/index";

describe("TokenTracker.extractUsage", () => {
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

describe("TokenTracker.calculateCost", () => {
  it("calculates cost for known model", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const cost = TokenTracker.calculateCost(usage, "claude-3-haiku-20240307");
    expect(cost.inputCost).toBeCloseTo(0.25);
    expect(cost.outputCost).toBeCloseTo(1.25);
    expect(cost.totalCost).toBeCloseTo(1.5);
  });

  it("returns zero cost for unknown model with warning", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const cost = TokenTracker.calculateCost(
      {
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      "unknown-model-xyz",
    );
    expect(cost.totalCost).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("calculates proportional cost for partial tokens", () => {
    const usage = {
      inputTokens: 500_000,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const cost = TokenTracker.calculateCost(usage, "gpt-4o-mini");
    expect(cost.inputCost).toBeCloseTo(0.075);
    expect(cost.outputCost).toBe(0);
  });
});
