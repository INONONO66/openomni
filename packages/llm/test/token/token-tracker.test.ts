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
  const opusCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

  it("calculates cost from modelCost rates", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cost = TokenTracker.calculateCost(usage, opusCost);
    expect(cost.inputCost).toBeCloseTo(5);
    expect(cost.outputCost).toBeCloseTo(25);
    expect(cost.totalCost).toBeCloseTo(30);
  });

  it("returns zero when no modelCost provided", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000 };
    const cost = TokenTracker.calculateCost(usage);
    expect(cost.totalCost).toBe(0);
    expect(cost.inputCost).toBe(0);
    expect(cost.outputCost).toBe(0);
  });

  it("calculates proportional cost for partial tokens", () => {
    const usage = { inputTokens: 500_000, outputTokens: 0 };
    const cost = TokenTracker.calculateCost(usage, { input: 2.5, output: 10 });
    expect(cost.inputCost).toBeCloseTo(1.25);
    expect(cost.outputCost).toBe(0);
  });

  it("includes cacheReadCost when cacheReadTokens > 0", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
    const cost = TokenTracker.calculateCost(usage, opusCost);
    expect(cost.cacheReadCost).toBeCloseTo(0.5);
    expect(cost.totalCost).toBeGreaterThan(30);
  });

  it("includes cacheWriteCost when cacheWriteTokens > 0", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    const cost = TokenTracker.calculateCost(usage, opusCost);
    expect(cost.cacheWriteCost).toBeCloseTo(6.25);
    expect(cost.totalCost).toBeGreaterThan(30);
  });

  it("includes reasoningCost when reasoningTokens > 0", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 1_000_000 };
    const cost = TokenTracker.calculateCost(usage, opusCost);
    expect(cost.reasoningCost).toBeCloseTo(25);
    expect(cost.totalCost).toBeCloseTo(55);
  });

  it("totalCost sums all components", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    const cost = TokenTracker.calculateCost(usage, opusCost);
    // 5 + 25 + 25(reasoning=output rate) + 0.5 + 6.25 = 61.75
    expect(cost.totalCost).toBeCloseTo(61.75);
  });

  it("derives cache/reasoning rates from input/output when not specified", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };
    const cost = TokenTracker.calculateCost(usage, { input: 10, output: 50 });
    // cacheRead = input * 0.1 = 1, cacheWrite = input * 1.25 = 12.5, reasoning = output = 50
    expect(cost.cacheReadCost).toBeCloseTo(1);
    expect(cost.cacheWriteCost).toBeCloseTo(12.5);
    expect(cost.reasoningCost).toBeCloseTo(50);
    expect(cost.totalCost).toBeCloseTo(10 + 50 + 1 + 12.5 + 50);
  });
});
