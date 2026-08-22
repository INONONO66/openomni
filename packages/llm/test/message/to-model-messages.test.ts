import { describe, expect, test } from "bun:test";
import type { Message } from "@openomni/protocol";
import { toModelMessages } from "../../src/message";
import type { Provider } from "../../src/provider";

const anthropicModel: Provider.Model = {
  id: "claude-3-5-sonnet",
  providerID: "anthropic",
  name: "Claude 3.5 Sonnet",
  api: { npm: "@ai-sdk/anthropic" },
};

function textPart(messageID: string, text: string, id = `part-${messageID}`): Message.TextPart {
  return { id, sessionID: "session-1", messageID, type: "text", text };
}

function userMessage(text = "Hello"): Message.WithParts {
  return {
    info: {
      id: "msg-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 1000 },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
    },
    parts: [textPart("msg-1", text, "part-1")],
  };
}

function assistantMessage(
  parts: Message.Part[] = [textPart("msg-2", "Response", "part-1")],
): Message.WithParts {
  return {
    info: {
      id: "msg-2",
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1100 },
      parentID: "msg-1",
      modelID: "claude-3-5-sonnet",
      providerID: "anthropic",
      agent: "default",
      path: { cwd: "/home/user", root: "/home/user/project" },
      cost: 0.001,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

describe("toModelMessages", () => {
  test("converts empty array", () => {
    expect(toModelMessages([], anthropicModel)).toEqual([]);
  });

  test("converts UserMessage to model message", () => {
    const result = toModelMessages([userMessage()], anthropicModel);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("Hello");
  });

  test("converts AssistantMessage to model message", () => {
    const result = toModelMessages([assistantMessage()], anthropicModel);
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.content).toBe("Response");
  });

  test("preserves assistant reasoning parts during conversion", () => {
    const reasoning: Message.ReasoningPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-2",
      type: "reasoning",
      text: "I should preserve this.",
      time: { start: 1100, end: 1101 },
    };
    const result = toModelMessages(
      [assistantMessage([reasoning, textPart("msg-2", "Final answer", "part-2")])],
      anthropicModel,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.content).toEqual([
      { type: "reasoning", text: "I should preserve this." },
      { type: "text", text: "Final answer" },
    ]);
  });

  test("converts mixed messages", () => {
    const result = toModelMessages([userMessage(), assistantMessage()], anthropicModel);
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toBe("Hello");
    expect(result[1]?.role).toBe("assistant");
    expect(result[1]?.content).toBe("Response");
  });

  test("calls ProviderTransform.normalizeMessages", () => {
    const result = toModelMessages([userMessage()], anthropicModel);
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

describe("toModelMessages tool-name wire sanitization (all providers)", () => {
  // A non-claude provider: the sanitize must run here too — the live-LLM
  // failure was an OpenAI-pattern proxy, and the claude-only normalize branch
  // never touches this model.
  const openaiModel: Provider.Model = {
    id: "gpt-4o",
    providerID: "openai-proxy",
    name: "Proxied",
    api: { npm: "@ai-sdk/openai" },
  };

  function assistantWithDottedToolCall(): Message.WithParts {
    return {
      info: {
        id: "msg-a",
        sessionID: "session-1",
        role: "assistant",
        time: { created: 1100, completed: 1200 },
        parentID: "msg-u",
        modelID: "gpt-4o",
        providerID: "openai-proxy",
        agent: "default",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      } as Message.AssistantMessage,
      parts: [
        {
          id: "part-tool",
          sessionID: "session-1",
          messageID: "msg-a",
          type: "tool",
          callID: "call-1",
          tool: "message.send",
          state: {
            status: "completed",
            input: { text: "hi" },
            output: "sent",
            time: { start: 1100, end: 1150 },
            title: "message.send",
            metadata: {},
          },
        } as Message.ToolPart,
      ],
    };
  }

  test("sanitizes tool-call and tool-result block names for a non-claude provider", () => {
    const result = toModelMessages([assistantWithDottedToolCall()], openaiModel);

    const assistant = result.find((m) => m.role === "assistant");
    const toolMsg = result.find((m) => m.role === "tool");
    if (!assistant || !Array.isArray(assistant.content))
      throw new Error("expected tool-call block");
    if (!toolMsg || !Array.isArray(toolMsg.content)) throw new Error("expected tool-result block");

    const toolCall = assistant.content.find((b) => b.type === "tool-call");
    const toolResult = toolMsg.content.find((b) => b.type === "tool-result");
    // The dotted internal name must not leak into the re-serialized history.
    expect((toolCall as { toolName?: string }).toolName).toBe("message_send");
    expect((toolResult as { toolName?: string }).toolName).toBe("message_send");
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
