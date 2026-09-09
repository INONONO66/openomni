import { describe, expect, test } from "bun:test";
import type { Token } from "@openomni/protocol";
import { accumulateUsage, Retry } from "../src";
import { APIError } from "../src/error";

describe("public accounting and attempt classification", () => {
  test("accumulates billed counts without billing auxiliary counters twice", () => {
    const total: Token.AgentUsage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
    accumulateUsage(total, { inputTokens: 4, outputTokens: 5, reasoningTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 });
    expect(total).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12, reasoningTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 });
    accumulateUsage(total, { inputTokens: 0, outputTokens: 0 });
    accumulateUsage(total, { inputTokens: 2, outputTokens: 3, reasoningTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 3 });
    expect(total).toEqual({ inputTokens: 7, outputTokens: 10, totalTokens: 17, reasoningTokens: 7, cacheReadTokens: 9, cacheWriteTokens: 11 });
  });

  test.each([
    [new Error("context_length_exceeded"), "context_overflow"],
    [new APIError({ message: "fixture", statusCode: 408, isRetryable: true }), "timeout"],
    [new APIError({ message: "fixture", statusCode: 400, isRetryable: false }), "validation_error"],
    [new APIError({ message: "fixture", statusCode: 503, isRetryable: true }), "transient_error"],
    [new Error("fixture"), "transient_error"],
  ] as const)("classifies the attempt %s as %s", (error, expected) => {
    expect(Retry.attemptReason(error)).toBe(expected);
  });
});
