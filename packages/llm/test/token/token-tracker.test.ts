import { describe, expect, it } from "bun:test";
import { TokenTracker } from "../../src/token/index";

const usageCases: Array<{
  name: string;
  response: Parameters<typeof TokenTracker.extractUsage>[0];
  expected: [number, number, number, number, number];
}> = [
  {
    name: "extracts AI SDK usage format",
    response: {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        inputTokenDetails: { noCacheTokens: 90, cacheReadTokens: 7, cacheWriteTokens: 3 },
        outputTokenDetails: { textTokens: 44, reasoningTokens: 6 },
        totalTokens: 150,
      },
    },
    expected: [100, 50, 6, 7, 3],
  },
  {
    name: "extracts Anthropic usage format",
    response: {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        reasoning_tokens: 12,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 3,
      },
    },
    expected: [100, 50, 12, 3, 7],
  },
  {
    name: "extracts OpenAI usage format",
    response: {
      usage: { prompt_tokens: 200, completion_tokens: 80 },
      providerMetadata: { openai: { reasoningTokens: 9 } },
    },
    expected: [200, 80, 9, 0, 0],
  },
  { name: "returns zeros when usage is missing", response: {}, expected: [0, 0, 0, 0, 0] },
];

describe("TokenTracker.extractUsage", () => {
  it.each(usageCases)("$name", ({ response, expected }) => {
    const result = TokenTracker.extractUsage(response);
    expect(result.inputTokens).toBe(expected[0]);
    expect(result.outputTokens).toBe(expected[1]);
    expect(result.reasoningTokens).toBe(expected[2]);
    expect(result.cacheReadTokens).toBe(expected[3]);
    expect(result.cacheWriteTokens).toBe(expected[4]);
  });
});
