import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/session/message";
import { toModelMessages } from "../../src/session/convert";
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
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Hello");
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
    expect(result[0].role).toBe("assistant");
    expect(result[0].content).toBe("Response");
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
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Hello");
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("Response");
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
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("Hello");
  });
});
