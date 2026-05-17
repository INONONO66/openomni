import { describe, expect, test } from "bun:test";
import { Token } from "../src/token/index.js";

describe("Token usage contracts", () => {
  test("parses provider usage without total tokens", () => {
    const usage = Token.ProviderUsage.parse({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 12,
      cacheReadTokens: 3,
      cacheWriteTokens: 7,
    });

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 12,
      cacheReadTokens: 3,
      cacheWriteTokens: 7,
    });
  });

  test("requires total tokens for agent usage", () => {
    expect(
      Token.AgentUsage.safeParse({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      }).success,
    ).toBe(true);

    expect(
      Token.AgentUsage.safeParse({
        inputTokens: 100,
        outputTokens: 50,
      }).success,
    ).toBe(false);
  });

  test("rejects negative and fractional token counts", () => {
    expect(
      Token.AgentUsage.safeParse({
        inputTokens: -1,
        outputTokens: 50,
        totalTokens: 49,
      }).success,
    ).toBe(false);

    expect(
      Token.ExecutionUsage.safeParse({
        inputTokens: 10.5,
      }).success,
    ).toBe(false);
  });

  test("allows partial execution result usage", () => {
    expect(Token.ExecutionUsage.parse({ inputTokens: 10 })).toEqual({ inputTokens: 10 });
  });
});
