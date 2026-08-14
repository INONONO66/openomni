import { describe, expect, test } from "bun:test";
import type { Message } from "@openomni/protocol";
import { toModelMessages } from "../../src/message";
import type { Provider } from "../../src/provider";

describe("toModelMessages", () => {
  test("converts empty array", () => {
    const model: Provider.Model = {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    };

    const result = toModelMessages([], model);
    expect(result).toEqual([]);
  });

  test("converts UserMessage to model message", () => {
    const model: Provider.Model = {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    };

    const userMsg: Message.WithParts = {
      info: {
        id: "msg-1",
        sessionID: "session-1",
        role: "user",
        time: { created: 1000 },
        agent: "default",
        model: {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
        },
      } as Message.UserMessage,
      parts: [
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
          text: "Hello",
        } as Message.TextPart,
      ],
    };

    const result = toModelMessages([userMsg], model);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("Hello");
  });

  test("converts AssistantMessage to model message", () => {
    const model: Provider.Model = {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    };

    const assistantMsg: Message.WithParts = {
      info: {
        id: "msg-2",
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1100 },
        parentID: "msg-1",
        modelID: "claude-3-5-sonnet",
        providerID: "anthropic",
        agent: "default",
        path: {
          cwd: "/home/user",
          root: "/home/user/project",
        },
        cost: 0.001,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
      } as Message.AssistantMessage,
      parts: [
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-2",
          type: "text",
          text: "Response",
        } as Message.TextPart,
      ],
    };

    const result = toModelMessages([assistantMsg], model);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.content).toBe("Response");
  });

  test("preserves assistant reasoning parts during conversion", () => {
    const model: Provider.Model = {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    };

    const assistantMsg: Message.WithParts = {
      info: {
        id: "msg-2",
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1100 },
        parentID: "msg-1",
        modelID: "claude-3-5-sonnet",
        providerID: "anthropic",
        agent: "default",
        path: {
          cwd: "/home/user",
          root: "/home/user/project",
        },
        cost: 0.001,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 12,
          cache: {
            read: 0,
            write: 0,
          },
        },
      } as Message.AssistantMessage,
      parts: [
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-2",
          type: "reasoning",
          text: "I should preserve this.",
          time: { start: 1100, end: 1101 },
        } as Message.ReasoningPart,
        {
          id: "part-2",
          sessionID: "session-1",
          messageID: "msg-2",
          type: "text",
          text: "Final answer",
        } as Message.TextPart,
      ],
    };

    const result = toModelMessages([assistantMsg], model);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
    // Reasoning must come first: Anthropic rejects assistant turns where a
    // thinking block follows other content.
    expect(result[0]?.content).toEqual([
      { type: "reasoning", text: "I should preserve this." },
      { type: "text", text: "Final answer" },
    ]);
  });

  test("converts mixed messages", () => {
    const model: Provider.Model = {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    };

    const userMsg: Message.WithParts = {
      info: {
        id: "msg-1",
        sessionID: "session-1",
        role: "user",
        time: { created: 1000 },
        agent: "default",
        model: {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
        },
      } as Message.UserMessage,
      parts: [
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
          text: "Hello",
        } as Message.TextPart,
      ],
    };

    const assistantMsg: Message.WithParts = {
      info: {
        id: "msg-2",
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1100 },
        parentID: "msg-1",
        modelID: "claude-3-5-sonnet",
        providerID: "anthropic",
        agent: "default",
        path: {
          cwd: "/home/user",
          root: "/home/user/project",
        },
        cost: 0.001,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
      } as Message.AssistantMessage,
      parts: [
        {
          id: "part-2",
          sessionID: "session-1",
          messageID: "msg-2",
          type: "text",
          text: "Response",
        } as Message.TextPart,
      ],
    };

    const result = toModelMessages([userMsg, assistantMsg], model);
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("Hello");
    expect(result[1]?.role).toBe("assistant");
    expect(result[1]?.content).toBe("Response");
  });

  test("calls ProviderTransform.normalizeMessages", () => {
    const model: Provider.Model = {
      id: "claude-3-5-sonnet",
      providerID: "anthropic",
      name: "Claude 3.5 Sonnet",
      api: {
        npm: "@ai-sdk/anthropic",
      },
    };

    const userMsg: Message.WithParts = {
      info: {
        id: "msg-1",
        sessionID: "session-1",
        role: "user",
        time: { created: 1000 },
        agent: "default",
        model: {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet",
        },
      } as Message.UserMessage,
      parts: [
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "msg-1",
          type: "text",
          text: "Hello",
        } as Message.TextPart,
      ],
    };

    const result = toModelMessages([userMsg], model);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("Hello");
  });
});

describe("toModelMessages error-turn exclusion (#545 T2)", () => {
  const model: Provider.Model = {
    id: "claude-3-5-sonnet",
    providerID: "anthropic",
    name: "Claude 3.5 Sonnet",
    api: { npm: "@ai-sdk/anthropic" },
  };

  function assistantInfo(
    overrides: Partial<Message.AssistantMessage> = {},
  ): Message.AssistantMessage {
    return {
      id: "msg-a",
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1100, completed: 1200 },
      parentID: "msg-u",
      modelID: "claude-3-5-sonnet",
      providerID: "anthropic",
      agent: "default",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...overrides,
    };
  }

  function textPart(messageID: string, text: string): Message.TextPart {
    return { id: `part-${messageID}`, sessionID: "session-1", messageID, type: "text", text };
  }

  test("excludes error-finished assistant turns from replay", () => {
    const userMsg: Message.WithParts = {
      info: {
        id: "msg-u",
        sessionID: "session-1",
        role: "user",
        time: { created: 1000 },
        agent: "default",
        model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
      },
      parts: [textPart("msg-u", "Hello")],
    };
    const errored: Message.WithParts = {
      info: assistantInfo({ finish: "error" }),
      parts: [textPart("msg-a", "half-written failure output")],
    };

    const result = toModelMessages([userMsg, errored], model);

    // The error turn never reaches the provider; only the user turn replays.
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
  });

  test("keeps stop-finished assistant turns in replay", () => {
    const stopped: Message.WithParts = {
      info: assistantInfo({ finish: "stop" }),
      parts: [textPart("msg-a", "Answer")],
    };

    const result = toModelMessages([stopped], model);

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
  });
});

describe("toModelMessages reasoning signature resend gate (#532 candidate 10)", () => {
  const outgoing: Provider.Model = {
    id: "claude-3-5-sonnet",
    providerID: "anthropic",
    name: "Claude 3.5 Sonnet",
    api: { npm: "@ai-sdk/anthropic" },
  };

  function reasoningMessage(overrides: Partial<Message.AssistantMessage> = {}): Message.WithParts {
    return {
      info: {
        id: "msg-r",
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1100, completed: 1200 },
        parentID: "msg-u",
        modelID: "claude-3-5-sonnet",
        providerID: "anthropic",
        agent: "default",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 4, cache: { read: 0, write: 0 } },
        ...overrides,
      },
      parts: [
        {
          id: "part-r",
          sessionID: "session-1",
          messageID: "msg-r",
          type: "reasoning",
          text: "step by step",
          signature: "sig-123",
          time: { start: 1100, end: 1150 },
        },
        {
          id: "part-t",
          sessionID: "session-1",
          messageID: "msg-r",
          type: "text",
          text: "Answer",
        },
      ],
    };
  }

  function reasoningBlockOf(result: ReturnType<typeof toModelMessages>) {
    const content = result[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected block content");
    return content.find((block) => block.type === "reasoning");
  }

  test("resends the signature when provider and model match the stored pair", () => {
    const result = toModelMessages([reasoningMessage()], outgoing);

    const block = reasoningBlockOf(result);
    expect(block).toMatchObject({
      type: "reasoning",
      text: "step by step",
      providerOptions: { anthropic: { signature: "sig-123" } },
    });
  });

  test("withholds the signature when the outgoing model differs", () => {
    const result = toModelMessages([reasoningMessage({ modelID: "claude-3-opus" })], outgoing);

    const block = reasoningBlockOf(result);
    expect(block).toMatchObject({ type: "reasoning", text: "step by step" });
    expect((block as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  test("withholds the signature when the outgoing provider differs", () => {
    const openaiModel: Provider.Model = {
      id: "claude-3-5-sonnet",
      providerID: "openai-proxy",
      name: "Proxied",
      api: { npm: "@ai-sdk/openai" },
    };

    const result = toModelMessages([reasoningMessage()], openaiModel);

    const block = reasoningBlockOf(result);
    expect((block as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });
});
