import { describe, expect, test } from "bun:test";
import { ProviderTransform } from "../../src/transform";
import type { Provider } from "../../src/provider/index";
type ModelMessage = Parameters<typeof ProviderTransform.normalizeMessages>[0][number];

describe("ProviderTransform.sdkKey", () => {
  test("maps anthropic packages", () => {
    expect(ProviderTransform.sdkKey("@ai-sdk/anthropic")).toBe("anthropic");
    expect(ProviderTransform.sdkKey("@ai-sdk/google-vertex/anthropic")).toBe("anthropic");
  });

  test("maps openai packages", () => {
    expect(ProviderTransform.sdkKey("@ai-sdk/openai")).toBe("openai");
    expect(ProviderTransform.sdkKey("@ai-sdk/azure")).toBe("openai");
  });

  test("maps google packages", () => {
    expect(ProviderTransform.sdkKey("@ai-sdk/google")).toBe("google");
    expect(ProviderTransform.sdkKey("@ai-sdk/google-vertex")).toBe("google");
  });

  test("maps openrouter", () => {
    expect(ProviderTransform.sdkKey("@openrouter/ai-sdk-provider")).toBe("openrouter");
  });

  test("returns undefined for unknown packages", () => {
    expect(ProviderTransform.sdkKey("unknown-package")).toBeUndefined();
  });
});

describe("ProviderTransform.normalizeMessages", () => {
  const anthropicModel = {
    npm: "@ai-sdk/anthropic",
    modelId: "claude-sonnet-4-20250514",
  };
  const openaiModel = { npm: "@ai-sdk/openai", modelId: "gpt-4o" };

  test("does not expose NormalizeOptions as a public namespace member", async () => {
    const transformSource = await Bun.file(
      new URL("../../src/transform/index.ts", import.meta.url),
    ).text();

    expect(Object.hasOwn(ProviderTransform, "NormalizeOptions")).toBe(false);
    expect(transformSource).not.toMatch(/\bexport\s+interface\s+NormalizeOptions\b/);
  });

  test("openai is passthrough", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "" },
      { role: "user", content: "hello" },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, openaiModel);
    expect(result).toEqual(msgs);
  });

  test("anthropic filters empty string content", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "" },
      { role: "user", content: "hello" },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("hello");
  });

  test("anthropic filters empty text parts from array content", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "actual content" },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(result).toHaveLength(1);
    expect(result[0].content).toEqual([{ type: "text", text: "actual content" }]);
  });

  test("anthropic removes message when all array parts are empty", () => {
    const msgs = [
      {
        role: "assistant" as const,
        content: [
          { type: "text", text: "" },
          { type: "reasoning", text: "" },
        ],
      },
    ] as ModelMessage[];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(result).toHaveLength(0);
  });

  test("anthropic sanitizes toolCallId for claude models", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call.with.dots/and/slashes",
            toolName: "test",
            input: {},
          },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(result).toHaveLength(1);
    const part = (result[0].content as Array<Record<string, unknown>>)[0];
    expect(part.toolCallId).toBe("call_with_dots_and_slashes");
  });

  test("anthropic sanitizes toolCallId on tool-result parts", () => {
    const msgs: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "id@with#special$chars",
            toolName: "test",
            output: "ok",
          },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    const part = (result[0].content as Array<Record<string, unknown>>)[0];
    expect(part.toolCallId).toBe("id_with_special_chars");
  });

  test("non-claude anthropic model skips toolCallId sanitization", () => {
    const nonClaudeAnthropicModel = {
      npm: "@ai-sdk/anthropic",
      modelId: "some-other-model",
    };
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call.with.dots",
            toolName: "test",
            input: {},
          },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, nonClaudeAnthropicModel);
    const part = (result[0].content as Array<Record<string, unknown>>)[0];
    expect(part.toolCallId).toBe("call.with.dots");
  });

  test("preserves non-text parts like tool-call in anthropic filtering", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          {
            type: "tool-call",
            toolCallId: "abc123",
            toolName: "test",
            input: {},
          },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(result).toHaveLength(1);
    expect((result[0].content as unknown[]).length).toBe(1);
    expect((result[0].content as Array<Record<string, unknown>>)[0].type).toBe("tool-call");
  });

  test("accepts Provider.Model directly", () => {
    const model: Provider.Model = {
      id: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      name: "Claude Sonnet 4",
      api: { npm: "@ai-sdk/anthropic" },
    };
    const msgs: ModelMessage[] = [
      { role: "user", content: "" },
      { role: "user", content: "hello" },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, model);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("hello");
  });
});

describe("ProviderTransform.variants", () => {
  test("returns thinking budgets for anthropic reasoning model", () => {
    const model: Provider.Model = {
      id: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      name: "Claude Sonnet 4",
      api: { npm: "@ai-sdk/anthropic" },
      capabilities: { reasoning: true },
      limit: { context: 200000, output: 32000 },
    };
    const v = ProviderTransform.variants(model);
    expect(v.high).toBeDefined();
    const highThinking = v.high.thinking as Record<string, unknown>;
    expect(highThinking.type).toBe("enabled");
    expect(highThinking.budgetTokens).toBe(15_999);
    expect(v.max).toBeDefined();
    const maxThinking = v.max.thinking as Record<string, unknown>;
    expect(maxThinking.type).toBe("enabled");
    expect(maxThinking.budgetTokens).toBe(31_999);
  });

  test("returns reasoning efforts for openai reasoning model", () => {
    const model: Provider.Model = {
      id: "o4-mini",
      providerID: "openai",
      name: "o4-mini",
      api: { npm: "@ai-sdk/openai" },
      capabilities: { reasoning: true },
    };
    const v = ProviderTransform.variants(model);
    expect(v.low).toBeDefined();
    expect(v.low.reasoningEffort).toBe("low");
    expect(v.medium.reasoningEffort).toBe("medium");
    expect(v.high.reasoningEffort).toBe("high");
  });

  test("returns empty for non-reasoning model", () => {
    const model: Provider.Model = {
      id: "gpt-4o",
      providerID: "openai",
      name: "GPT-4o",
      api: { npm: "@ai-sdk/openai" },
      capabilities: { reasoning: false },
    };
    const v = ProviderTransform.variants(model);
    expect(Object.keys(v)).toHaveLength(0);
  });

  test("returns empty for model with no capabilities", () => {
    const model: Provider.Model = {
      id: "test-model",
      providerID: "test",
      name: "Test",
      api: { npm: "@ai-sdk/openai" },
    };
    const v = ProviderTransform.variants(model);
    expect(Object.keys(v)).toHaveLength(0);
  });
});

describe("ProviderTransform.applyAnthropicCaching", () => {
  const EXPECTED_OPTS = {
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
  };

  test("returns empty array unchanged", () => {
    expect(ProviderTransform.applyAnthropicCaching([])).toEqual([]);
  });

  test("single system message gets cacheControl", () => {
    const msgs: ModelMessage[] = [{ role: "system", content: "you are helpful" }];
    const result = ProviderTransform.applyAnthropicCaching(msgs);
    expect(result).toEqual([{ role: "system", content: "you are helpful", ...EXPECTED_OPTS }]);
  });

  test("single user message gets cacheControl", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hello" }];
    const result = ProviderTransform.applyAnthropicCaching(msgs);
    expect(result).toEqual([{ role: "user", content: "hello", ...EXPECTED_OPTS }]);
  });

  test("system msgs and last 2 user/assistant get cacheControl", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
    ];
    const result = ProviderTransform.applyAnthropicCaching(msgs);

    expect(result[0]).toEqual({ role: "system", content: "sys", ...EXPECTED_OPTS });
    expect((result[1] as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((result[2] as Record<string, unknown>).providerOptions).toBeUndefined();
    expect(result[3]).toEqual({ role: "user", content: "msg3", ...EXPECTED_OPTS });
    expect(result[4]).toEqual({ role: "assistant", content: "msg4", ...EXPECTED_OPTS });
  });

  test("tool messages are never cached", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "run tool" },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t1", toolName: "x", output: "ok" }],
      },
      { role: "assistant", content: "done" },
    ];
    const result = ProviderTransform.applyAnthropicCaching(msgs);
    expect((result[1] as Record<string, unknown>).providerOptions).toBeUndefined();
    expect(result[0]).toEqual({ role: "user", content: "run tool", ...EXPECTED_OPTS });
    expect(result[2]).toEqual({ role: "assistant", content: "done", ...EXPECTED_OPTS });
  });

  test("does not mutate original messages", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hello" }];
    const original = { ...msgs[0] };
    ProviderTransform.applyAnthropicCaching(msgs);
    expect(msgs[0]).toEqual(original);
  });

  test("all system messages get cacheControl", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
    ];
    const result = ProviderTransform.applyAnthropicCaching(msgs);
    expect((result[0] as Record<string, unknown>).providerOptions).toEqual(
      EXPECTED_OPTS.providerOptions,
    );
    expect((result[1] as Record<string, unknown>).providerOptions).toEqual(
      EXPECTED_OPTS.providerOptions,
    );
  });
});

describe("normalizeMessages applies caching for anthropic", () => {
  const anthropicModel = { npm: "@ai-sdk/anthropic", modelId: "claude-sonnet-4-20250514" };
  const openaiModel = { npm: "@ai-sdk/openai", modelId: "gpt-4o" };

  test("anthropic messages get cacheControl via normalizeMessages", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(
      (
        (result[0] as Record<string, unknown>).providerOptions as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.anthropic?.cacheControl,
    ).toEqual({ type: "ephemeral" });
    expect(
      (
        (result[1] as Record<string, unknown>).providerOptions as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.anthropic?.cacheControl,
    ).toEqual({ type: "ephemeral" });
  });

  test("openai messages do not get cacheControl", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, openaiModel);
    expect((result[0] as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((result[1] as Record<string, unknown>).providerOptions).toBeUndefined();
  });
});

describe("ProviderTransform.temperature", () => {
  test("returns undefined for claude models", () => {
    const model: Provider.Model = {
      id: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      name: "Claude Sonnet 4",
      api: { npm: "@ai-sdk/anthropic" },
    };
    expect(ProviderTransform.temperature(model)).toBeUndefined();
  });

  test("returns undefined for non-claude models", () => {
    const model: Provider.Model = {
      id: "gpt-4o",
      providerID: "openai",
      name: "GPT-4o",
      api: { npm: "@ai-sdk/openai" },
    };
    expect(ProviderTransform.temperature(model)).toBeUndefined();
  });
});

describe("ProviderTransform.topP", () => {
  test("returns undefined", () => {
    const model: Provider.Model = {
      id: "gpt-4o",
      providerID: "openai",
      name: "GPT-4o",
      api: { npm: "@ai-sdk/openai" },
    };
    expect(ProviderTransform.topP(model)).toBeUndefined();
  });
});

describe("ProviderTransform.resolveVariant", () => {
  test("resolveVariant with anthropic reasoning model and high variant", () => {
    const model: Provider.Model = {
      id: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      name: "Claude Sonnet 4",
      api: { npm: "@ai-sdk/anthropic" },
      capabilities: { reasoning: true },
      limit: { context: 200000, output: 32000 },
    };
    const result = ProviderTransform.resolveVariant(model, "high");
    expect(result).toBeDefined();
    expect(result.thinking).toBeDefined();
    expect((result.thinking as Record<string, unknown>).type).toBe("enabled");
  });

  test("resolveVariant with openai reasoning model and low variant", () => {
    const model: Provider.Model = {
      id: "o4-mini",
      providerID: "openai",
      name: "o4-mini",
      api: { npm: "@ai-sdk/openai" },
      capabilities: { reasoning: true },
    };
    const result = ProviderTransform.resolveVariant(model, "low");
    expect(result).toBeDefined();
    expect(result.reasoningEffort).toBe("low");
    expect(result.reasoningSummary).toBe("auto");
  });

  test("resolveVariant with openai model ref uses the shared model ref guard", () => {
    const result = ProviderTransform.resolveVariant({ provider: "openai", id: "o4-mini" }, "low");

    expect(result.reasoningEffort).toBe("low");
    expect(result.reasoningSummary).toBe("auto");
  });

  test("resolveVariant with anthropic model ref returns thinking options", () => {
    const result = ProviderTransform.resolveVariant(
      { provider: "anthropic", id: "claude-sonnet-4-20250514" },
      "high",
    );

    expect((result.thinking as Record<string, unknown>).type).toBe("enabled");
  });

  test("resolveVariant with non-reasoning model returns empty object", () => {
    const model: Provider.Model = {
      id: "gpt-4o",
      providerID: "openai",
      name: "GPT-4o",
      api: { npm: "@ai-sdk/openai" },
      capabilities: { reasoning: false },
    };
    const result = ProviderTransform.resolveVariant(model, "high");
    expect(result).toEqual({});
  });

  test("resolveVariant with undefined variant returns empty object", () => {
    const model: Provider.Model = {
      id: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      name: "Claude Sonnet 4",
      api: { npm: "@ai-sdk/anthropic" },
      capabilities: { reasoning: true },
      limit: { context: 200000, output: 32000 },
    };
    const result = ProviderTransform.resolveVariant(model, undefined);
    expect(result).toEqual({});
  });

  test("resolveVariant with unknown variant returns empty object", () => {
    const model: Provider.Model = {
      id: "o4-mini",
      providerID: "openai",
      name: "o4-mini",
      api: { npm: "@ai-sdk/openai" },
      capabilities: { reasoning: true },
    };
    const result = ProviderTransform.resolveVariant(model, "unknownVariant");
    expect(result).toEqual({});
  });
});
