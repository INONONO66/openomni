import { describe, expect, test } from "bun:test";
import { ProviderTransform } from "../../src/provider/transform";
import type { Provider } from "../../src/provider/index";
type ModelMessage = Parameters<typeof ProviderTransform.normalizeMessages>[0][number];

describe("ProviderTransform.normalizeMessages", () => {
  const anthropicModel = {
    npm: "@ai-sdk/anthropic",
    modelId: "claude-sonnet-4-20250514",
  };
  const openaiModel = { npm: "@ai-sdk/openai", modelId: "gpt-4o" };

  test("does not expose NormalizeOptions as a public namespace member", async () => {
    const transformSource = await Bun.file(
      new URL("../../src/provider/transform.ts", import.meta.url),
    ).text();

    expect(Object.hasOwn(ProviderTransform, "NormalizeOptions")).toBe(false);
    expect(Object.hasOwn(ProviderTransform, "sdkKey")).toBe(false);
    expect(Object.hasOwn(ProviderTransform, "temperature")).toBe(false);
    expect(Object.hasOwn(ProviderTransform, "topP")).toBe(false);
    expect(transformSource).not.toMatch(/\bexport\s+interface\s+NormalizeOptions\b/);
    expect(transformSource).not.toMatch(/\bsdkKey\b/);
    expect(transformSource).not.toMatch(/\btemperature\b/);
    expect(transformSource).not.toMatch(/\btopP\b/);
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
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("hello");
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
    expect(result[0]?.content).toEqual([{ type: "text", text: "actual content" }]);
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
    const content = result[0]?.content;
    if (!Array.isArray(content)) throw new TypeError("expected array content");
    const part = content[0];
    if (part?.type !== "tool-call") throw new TypeError("expected a tool-call part");
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
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    const content = result[0]?.content;
    if (!Array.isArray(content)) throw new TypeError("expected array content");
    const part = content[0];
    if (part?.type !== "tool-result") throw new TypeError("expected a tool-result part");
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
    const part = (result[0]?.content as Array<Record<string, unknown>>)[0];
    expect(part?.toolCallId).toBe("call.with.dots");
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
    const content = result[0]?.content;
    if (!Array.isArray(content)) throw new TypeError("expected array content");
    expect(content.length).toBe(1);
    expect(content[0]?.type).toBe("tool-call");
  });

  test("preserves non-empty reasoning parts while filtering empty reasoning parts", () => {
    const msgs = [
      {
        role: "assistant" as const,
        content: [
          { type: "reasoning", text: "" },
          { type: "reasoning", text: "keep me" },
        ],
      },
    ] as ModelMessage[];

    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toEqual([{ type: "reasoning", text: "keep me" }]);
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
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("hello");
  });
});

describe("ProviderTransform.applyAnthropicCaching", () => {
  const EXPECTED_OPTS = {
    providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
  };

  test("returns empty array unchanged", () => {
    expect(ProviderTransform.applyAnthropicCaching([])).toEqual([]);
  });

  test("single user message gets the breakpoint with 1h ttl", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hello" }];
    const result = ProviderTransform.applyAnthropicCaching(msgs);
    expect(result).toEqual([{ role: "user", content: "hello", ...EXPECTED_OPTS }]);
  });

  test("only the latest user message is marked in a multi-turn history", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
    ];
    const result = ProviderTransform.applyAnthropicCaching(msgs);

    expect((result[0] as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((result[1] as Record<string, unknown>).providerOptions).toBeUndefined();
    expect(result[2]).toEqual({ role: "user", content: "msg3", ...EXPECTED_OPTS });
    expect((result[3] as Record<string, unknown>).providerOptions).toBeUndefined();
  });

  test("tool and assistant messages are never marked", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "run tool" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t1",
            toolName: "x",
            output: { type: "text", value: "ok" },
          },
        ],
      },
      { role: "assistant", content: "done" },
    ];
    const result = ProviderTransform.applyAnthropicCaching(msgs);
    expect(result[0]).toEqual({ role: "user", content: "run tool", ...EXPECTED_OPTS });
    expect((result[1] as Record<string, unknown>).providerOptions).toBeUndefined();
    expect((result[2] as Record<string, unknown>).providerOptions).toBeUndefined();
  });

  test("history without a user message is returned unchanged", () => {
    const msgs: ModelMessage[] = [{ role: "assistant", content: "solo" }];
    const result = ProviderTransform.applyAnthropicCaching(msgs);
    expect((result[0] as Record<string, unknown>).providerOptions).toBeUndefined();
  });

  test("does not mutate original messages", () => {
    const msgs: ModelMessage[] = [{ role: "user", content: "hello" }];
    const original = structuredClone(msgs[0]);
    ProviderTransform.applyAnthropicCaching(msgs);
    expect(msgs[0]).toEqual(original);
  });

  test("existing providerOptions on the marked message are preserved", () => {
    const msgs: ModelMessage[] = [
      {
        role: "user",
        content: "hello",
        providerOptions: { anthropic: { foo: "bar" } },
      } as ModelMessage,
    ];
    const result = ProviderTransform.applyAnthropicCaching(msgs);
    expect((result[0] as Record<string, unknown>).providerOptions).toEqual({
      anthropic: { foo: "bar", cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  });
});

describe("ProviderTransform.anthropicCacheOptions", () => {
  test("returns the 1h breakpoint for anthropic models", () => {
    const model: Provider.Model = {
      id: "claude-sonnet-4-20250514",
      providerID: "anthropic",
      name: "Sonnet",
      api: { npm: "@ai-sdk/anthropic" },
    };
    expect(ProviderTransform.anthropicCacheOptions(model)).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  });

  test("returns undefined for non-anthropic models", () => {
    const model: Provider.Model = {
      id: "gpt-4o",
      providerID: "openai",
      name: "GPT",
      api: { npm: "@ai-sdk/openai" },
    };
    expect(ProviderTransform.anthropicCacheOptions(model)).toBeUndefined();
  });

  test("returns undefined when the model has no api metadata", () => {
    const model: Provider.Model = { id: "m", providerID: "p", name: "M" };
    expect(ProviderTransform.anthropicCacheOptions(model)).toBeUndefined();
  });
});

describe("normalizeMessages applies caching for anthropic", () => {
  const anthropicModel = { npm: "@ai-sdk/anthropic", modelId: "claude-sonnet-4-20250514" };
  const openaiModel = { npm: "@ai-sdk/openai", modelId: "gpt-4o" };

  test("anthropic latest user message gets cacheControl via normalizeMessages", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(
      (
        (result[0] as Record<string, unknown>).providerOptions as
          | Record<string, Record<string, unknown>>
          | undefined
      )?.anthropic?.cacheControl,
    ).toEqual({ type: "ephemeral", ttl: "1h" });
    expect((result[1] as Record<string, unknown>).providerOptions).toBeUndefined();
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
