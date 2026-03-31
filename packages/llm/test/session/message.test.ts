import { describe, expect, test } from "bun:test";
import { Message } from "../../src/session/message";

describe("Message.TextPart", () => {
  test("creates valid TextPart", () => {
    const part: Message.TextPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "text",
      text: "Hello world",
      time: {
        start: 1000,
        end: 1100,
      },
    };

    const result = Message.TextPart.safeParse(part);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("text");
      expect(result.data.text).toBe("Hello world");
    }
  });

  test("TextPart with optional metadata", () => {
    const part: Message.TextPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "text",
      text: "Hello",
      metadata: { source: "user" },
    };

    const result = Message.TextPart.safeParse(part);
    expect(result.success).toBe(true);
  });

  test("TextPart without time is valid", () => {
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "text",
      text: "Hello",
    };

    const result = Message.TextPart.safeParse(part);
    expect(result.success).toBe(true);
  });
});

describe("Message.ReasoningPart", () => {
  test("creates valid ReasoningPart", () => {
    const part: Message.ReasoningPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "reasoning",
      text: "Let me think about this...",
      time: {
        start: 1000,
        end: 1500,
      },
    };

    const result = Message.ReasoningPart.safeParse(part);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("reasoning");
    }
  });

  test("ReasoningPart requires time", () => {
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "reasoning",
      text: "Thinking...",
    };

    const result = Message.ReasoningPart.safeParse(part);
    expect(result.success).toBe(false);
  });

  test("ReasoningPart with metadata", () => {
    const part: Message.ReasoningPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "reasoning",
      text: "Analysis",
      time: { start: 1000, end: 1100 },
      metadata: { depth: "deep" },
    };

    const result = Message.ReasoningPart.safeParse(part);
    expect(result.success).toBe(true);
  });
});

describe("Message.StepStartPart", () => {
  test("creates valid StepStartPart", () => {
    const part: Message.StepStartPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "step-start",
    };

    const result = Message.StepStartPart.safeParse(part);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("step-start");
    }
  });
});

describe("Message.StepFinishPart", () => {
  test("creates valid StepFinishPart", () => {
    const part: Message.StepFinishPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "step-finish",
      reason: "completed",
      cost: 0.001,
      tokens: {
        input: 100,
        output: 50,
        reasoning: 5,
        cache: {
          read: 2,
          write: 3,
        },
      },
    };

    const result = Message.StepFinishPart.safeParse(part);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("step-finish");
      expect(result.data.reason).toBe("completed");
    }
  });
});

describe("Message.RetryPart", () => {
  test("creates valid RetryPart", () => {
    const part: Message.RetryPart = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "retry",
      attempt: 2,
      error: {
        name: "APIError",
        data: {
          message: "Rate limited",
          statusCode: 429,
          isRetryable: true,
        },
      },
      time: {
        created: 1000,
      },
    };

    const result = Message.RetryPart.safeParse(part);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("retry");
      expect(result.data.attempt).toBe(2);
    }
  });
});

describe("Message.Part discriminated union", () => {
  test("Part discriminates TextPart", () => {
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "text",
      text: "Hello",
    };

    const result = Message.Part.safeParse(part);
    expect(result.success).toBe(true);
  });

  test("Part discriminates ReasoningPart", () => {
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "reasoning",
      text: "Thinking",
      time: { start: 1000 },
    };

    const result = Message.Part.safeParse(part);
    expect(result.success).toBe(true);
  });

  test("Part discriminates StepStartPart", () => {
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "step-start",
    };

    const result = Message.Part.safeParse(part);
    expect(result.success).toBe(true);
  });

  test("Part rejects invalid type", () => {
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "msg-1",
      type: "invalid",
    };

    const result = Message.Part.safeParse(part);
    expect(result.success).toBe(false);
  });
});

describe("Message.UserMessage", () => {
  test("creates valid UserMessage", () => {
    const msg: Message.UserMessage = {
      id: "msg-1",
      sessionID: "session-1",
      role: "user",
      time: {
        created: 1000,
      },
      agent: "default",
      model: {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
      },
    };

    const result = Message.UserMessage.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("user");
    }
  });

  test("UserMessage with optional fields", () => {
    const msg: Message.UserMessage = {
      id: "msg-1",
      sessionID: "session-1",
      role: "user",
      time: {
        created: 1000,
      },
      agent: "default",
      model: {
        providerID: "anthropic",
        modelID: "claude-3-5-sonnet",
      },
      system: "You are helpful",
      tools: { search: true },
      variant: "high",
    };

    const result = Message.UserMessage.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

describe("Message.AssistantMessage", () => {
  test("creates valid AssistantMessage", () => {
    const msg: Message.AssistantMessage = {
      id: "msg-2",
      sessionID: "session-1",
      role: "assistant",
      time: {
        created: 1100,
      },
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

    const result = Message.AssistantMessage.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("assistant");
    }
  });

  test("AssistantMessage with optional fields", () => {
    const msg: Message.AssistantMessage = {
      id: "msg-2",
      sessionID: "session-1",
      role: "assistant",
      time: {
        created: 1100,
        completed: 1200,
      },
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
      finish: "stop",
    };

    const result = Message.AssistantMessage.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

describe("Message.Info discriminated union", () => {
  test("Info discriminates UserMessage", () => {
    const msg = {
      id: "msg-1",
      sessionID: "session-1",
      role: "user",
      time: { created: 1000 },
      agent: "default",
      model: { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
    };

    const result = Message.Info.safeParse(msg);
    expect(result.success).toBe(true);
  });

  test("Info discriminates AssistantMessage", () => {
    const msg = {
      id: "msg-2",
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1100 },
      parentID: "msg-1",
      modelID: "claude-3-5-sonnet",
      providerID: "anthropic",
      agent: "default",
      path: { cwd: "/home", root: "/home/project" },
      cost: 0.001,
      tokens: {
        input: 100,
        output: 50,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };

    const result = Message.Info.safeParse(msg);
    expect(result.success).toBe(true);
  });
});
