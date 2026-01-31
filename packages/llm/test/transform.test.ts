import { describe, expect, test } from "bun:test";
import type { CoreMessage } from "ai";
import { ProviderTransform } from "../src/provider/transform";

describe("ProviderTransform.sdkKey", () => {
  test("maps anthropic packages", () => {
    expect(ProviderTransform.sdkKey("@ai-sdk/anthropic")).toBe("anthropic");
    expect(ProviderTransform.sdkKey("@ai-sdk/google-vertex/anthropic")).toBe(
      "anthropic",
    );
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
    expect(ProviderTransform.sdkKey("@openrouter/ai-sdk-provider")).toBe(
      "openrouter",
    );
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

  test("openai is passthrough", () => {
    const msgs: CoreMessage[] = [
      { role: "user", content: "" },
      { role: "user", content: "hello" },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, openaiModel);
    expect(result).toEqual(msgs);
  });

  test("anthropic filters empty string content", () => {
    const msgs: CoreMessage[] = [
      { role: "user", content: "" },
      { role: "user", content: "hello" },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
  });

  test("anthropic filters empty text parts from array content", () => {
    const msgs: CoreMessage[] = [
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
    expect(result[0].content).toEqual([
      { type: "text", text: "actual content" },
    ]);
  });

  test("anthropic removes message when all array parts are empty", () => {
    const msgs: CoreMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "reasoning", text: "" },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(result).toHaveLength(0);
  });

  test("anthropic sanitizes toolCallId for claude models", () => {
    const msgs: CoreMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call.with.dots/and/slashes",
            toolName: "test",
            args: {},
          },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(result).toHaveLength(1);
    const part = (result[0].content as any[])[0];
    expect(part.toolCallId).toBe("call_with_dots_and_slashes");
  });

  test("anthropic sanitizes toolCallId on tool-result parts", () => {
    const msgs: CoreMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "id@with#special$chars",
            toolName: "test",
            result: "ok",
          },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    const part = (result[0].content as any[])[0];
    expect(part.toolCallId).toBe("id_with_special_chars");
  });

  test("non-claude anthropic model skips toolCallId sanitization", () => {
    const nonClaudeAnthropicModel = {
      npm: "@ai-sdk/anthropic",
      modelId: "some-other-model",
    };
    const msgs: CoreMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call.with.dots",
            toolName: "test",
            args: {},
          },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(
      msgs,
      nonClaudeAnthropicModel,
    );
    const part = (result[0].content as any[])[0];
    expect(part.toolCallId).toBe("call.with.dots");
  });

  test("preserves non-text parts like tool-call in anthropic filtering", () => {
    const msgs: CoreMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          {
            type: "tool-call",
            toolCallId: "abc123",
            toolName: "test",
            args: {},
          },
        ],
      },
    ];
    const result = ProviderTransform.normalizeMessages(msgs, anthropicModel);
    expect(result).toHaveLength(1);
    expect((result[0].content as any[]).length).toBe(1);
    expect((result[0].content as any[])[0].type).toBe("tool-call");
  });
});
