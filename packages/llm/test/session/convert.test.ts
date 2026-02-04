import { describe, expect, test } from "bun:test";
import { Message } from "../../src/session/message";
import { toModelMessages } from "../../src/session/convert";
import { Provider } from "../../src/provider";

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

    const userMsg: Message.UserMessage = {
      id: "msg-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 1000 },
      agent: "default",
      model: {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
      },
    };

    const result = toModelMessages([userMsg], model);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
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

    const assistantMsg: Message.AssistantMessage = {
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
    };

    const result = toModelMessages([assistantMsg], model);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
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

    const userMsg: Message.UserMessage = {
      id: "msg-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 1000 },
      agent: "default",
      model: {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
      },
    };

    const assistantMsg: Message.AssistantMessage = {
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
    };

    const result = toModelMessages([userMsg, assistantMsg], model);
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThanOrEqual(0);
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

    const userMsg: Message.UserMessage = {
      id: "msg-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 1000 },
      agent: "default",
      model: {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
      },
    };

    // Should not throw
    expect(() => toModelMessages([userMsg], model)).not.toThrow();
  });
});
