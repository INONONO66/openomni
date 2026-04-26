import { describe, expect, it } from "bun:test";
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

  it("calculateCost prefers modelCost over static map", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const cost = TokenTracker.calculateCost(usage, "claude-opus-4-5", {
      input: 5.0,
      output: 15.0,
    });
    expect(cost.inputCost).toBeCloseTo(5.0);
    expect(cost.outputCost).toBeCloseTo(15.0);
    expect(cost.totalCost).toBeCloseTo(20.0);
  });

  it("calculateCost falls back to static MODEL_PRICING for known models", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const cost = TokenTracker.calculateCost(usage, "claude-opus-4-5");
    expect(cost.inputCost).toBeCloseTo(15.0);
    expect(cost.outputCost).toBeCloseTo(75.0);
    expect(cost.totalCost).toBeCloseTo(90.0);
  });

  it("calculateCost returns zero with warning for unknown model without modelCost", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const cost = TokenTracker.calculateCost(usage, "unknown-model-xyz");
    expect(cost.totalCost).toBe(0);
    expect(cost.inputCost).toBe(0);
    expect(cost.outputCost).toBe(0);
  });

  it("calculateCost includes cacheReadCost when cacheReadTokens > 0", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    };
    const cost = TokenTracker.calculateCost(usage, "claude-opus-4-5");
    expect(cost.cacheReadCost).toBeDefined();
    expect(cost.cacheReadCost).toBeGreaterThan(0);
    expect(cost.totalCost).toBeGreaterThan(90.0);
  });

  it("calculateCost includes cacheWriteCost when cacheWriteTokens > 0", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
    };
    const cost = TokenTracker.calculateCost(usage, "claude-opus-4-5");
    expect(cost.cacheWriteCost).toBeDefined();
    expect(cost.cacheWriteCost).toBeGreaterThan(0);
    expect(cost.totalCost).toBeGreaterThan(90.0);
  });

  it("calculateCost includes reasoningCost when reasoningTokens > 0", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const cost = TokenTracker.calculateCost(usage, "claude-opus-4-5");
    expect(cost.reasoningCost).toBeDefined();
    expect(cost.reasoningCost).toBeGreaterThan(0);
    expect(cost.totalCost).toBeGreaterThan(90.0);
  });

  it("totalCost sums all components", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    const cost = TokenTracker.calculateCost(usage, "claude-opus-4-5");
    const expectedTotal =
      (cost.inputCost ?? 0) +
      (cost.outputCost ?? 0) +
      (cost.cacheReadCost ?? 0) +
      (cost.cacheWriteCost ?? 0) +
      (cost.reasoningCost ?? 0);
    expect(cost.totalCost).toBeCloseTo(expectedTotal);
  });

  it("calculateCost handles partial modelCost (only input/output, no cache/reasoning)", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    const cost = TokenTracker.calculateCost(usage, "claude-opus-4-5", {
      input: 5.0,
      output: 15.0,
    });
    expect(cost.inputCost).toBeCloseTo(5.0);
    expect(cost.outputCost).toBeCloseTo(15.0);
    expect(cost.cacheReadCost).toBeDefined();
    expect(cost.cacheWriteCost).toBeDefined();
    expect(cost.reasoningCost).toBeDefined();
  });
});
