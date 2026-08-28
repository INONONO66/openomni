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
  {
    name: "keeps a legitimate zero instead of falling through to lower-priority aliases",
    response: {
      usage: {
        inputTokens: 0,
        input_tokens: 11,
        outputTokens: 0,
        output_tokens: 10,
        outputTokenDetails: { reasoningTokens: 0 },
        reasoningTokens: 12,
        inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
        cacheReadTokens: 13,
        cacheWriteTokens: 14,
      },
    },
    expected: [0, 0, 0, 0, 0],
  },
  {
    name: "rejects negative token counts",
    response: {
      usage: {
        inputTokens: -1,
        outputTokens: -2,
        reasoningTokens: -3,
        cacheReadTokens: -4,
        cacheWriteTokens: -5,
      },
    },
    expected: [0, 0, 0, 0, 0],
  },
  {
    name: "rejects NaN and infinite token counts",
    response: {
      usage: {
        inputTokens: Number.NaN,
        outputTokens: Number.POSITIVE_INFINITY,
        reasoningTokens: Number.NEGATIVE_INFINITY,
      },
      providerMetadata: {
        anthropic: {
          cacheReadInputTokens: Number.NaN,
          cacheCreationInputTokens: Number.POSITIVE_INFINITY,
        },
      },
    },
    expected: [0, 0, 0, 0, 0],
  },
  {
    name: "rejects fractional and unsafe token counts",
    response: {
      usage: {
        inputTokens: 1.5,
        outputTokens: Number.MAX_SAFE_INTEGER + 1,
        cacheReadTokens: 2.5,
        cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    expected: [0, 0, 0, 0, 0],
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
