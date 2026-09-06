import { describe, expect, test } from "bun:test";
import { Token } from "../src/token/index.js";

describe("Token usage contracts", () => {
  test("provider usage is a static input and runtime agent usage validates the full accounting record", () => {
    const input: Token.ProviderUsage = {
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 12,
      cacheReadTokens: 3,
      cacheWriteTokens: 7,
    };
    const usage = Token.AgentUsage.parse({ ...input, totalTokens: 150 });
    expect("ProviderUsage" in Token).toBe(false);
    expect("Usage" in Token).toBe(false);
    expect(usage).toEqual({
      totalTokens: 150,
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

  test("rejects negative token counts", () => {
    expect(
      Token.AgentUsage.safeParse({
        inputTokens: -1,
        outputTokens: 50,
        totalTokens: 49,
      }).success,
    ).toBe(false);
  });
});
