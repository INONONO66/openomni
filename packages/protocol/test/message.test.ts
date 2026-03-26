import { describe, test, expect } from "bun:test";
import { Message } from "../src/message/index.js";

const base = { id: "p-1", sessionID: "ses-1", messageID: "msg-1" };

describe("Message.TextPart", () => {
  test("parses valid minimal text part", () => {
    const part = Message.TextPart.parse({
      ...base,
      type: "text",
      text: "hello",
    });

    expect(part.type).toBe("text");
    expect(part.text).toBe("hello");
    expect(part.time).toBeUndefined();
    expect(part.metadata).toBeUndefined();
  });

  test("parses valid full text part with time and metadata", () => {
    const part = Message.TextPart.parse({
      ...base,
      type: "text",
      text: "hello",
      time: { start: 100, end: 200 },
      metadata: { source: "user" },
    });

    expect(part.time!.start).toBe(100);
    expect(part.time!.end).toBe(200);
    expect(part.metadata).toEqual({ source: "user" });
  });

  test("rejects missing text", () => {
    expect(() => Message.TextPart.parse({ ...base, type: "text" })).toThrow();
  });
});

describe("Message.ReasoningPart", () => {
  test("parses valid reasoning part with required time", () => {
    const part = Message.ReasoningPart.parse({
      ...base,
      type: "reasoning",
      text: "thinking...",
      time: { start: 10 },
    });

    expect(part.type).toBe("reasoning");
    expect(part.text).toBe("thinking...");
    expect(part.time.start).toBe(10);
    expect(part.time.end).toBeUndefined();
  });

  test("rejects missing time", () => {
    expect(() =>
      Message.ReasoningPart.parse({
        ...base,
        type: "reasoning",
        text: "thinking...",
      }),
    ).toThrow();
  });

  test("rejects missing text", () => {
    expect(() =>
      Message.ReasoningPart.parse({
        ...base,
        type: "reasoning",
        time: { start: 10 },
      }),
    ).toThrow();
  });
});

describe("Message.StepStartPart", () => {
  test("parses valid step-start part", () => {
    const part = Message.StepStartPart.parse({
      ...base,
      type: "step-start",
    });

    expect(part.type).toBe("step-start");
    expect(part.id).toBe("p-1");
  });
});

describe("Message.StepFinishPart", () => {
  test("parses valid step-finish part", () => {
    const part = Message.StepFinishPart.parse({
      ...base,
      type: "step-finish",
      reason: "end_turn",
      cost: 0.05,
      tokens: { input: 100, output: 50 },
    });

    expect(part.type).toBe("step-finish");
    expect(part.reason).toBe("end_turn");
    expect(part.cost).toBe(0.05);
    expect(part.tokens).toEqual({ input: 100, output: 50 });
  });

  test("rejects missing cost", () => {
    expect(() =>
      Message.StepFinishPart.parse({
        ...base,
        type: "step-finish",
        reason: "end_turn",
        tokens: { input: 100, output: 50 },
      }),
    ).toThrow();
  });

  test("rejects missing tokens", () => {
    expect(() =>
      Message.StepFinishPart.parse({
        ...base,
        type: "step-finish",
        reason: "end_turn",
        cost: 0.05,
      }),
    ).toThrow();
  });
});

describe("Message.RetryPart", () => {
  test("parses valid retry part with serialized APIError", () => {
    const part = Message.RetryPart.parse({
      ...base,
      type: "retry",
      attempt: 2,
      error: {
        name: "APIError",
        data: { message: "rate limited", isRetryable: true },
      },
      time: { created: 1000 },
    });

    expect(part.type).toBe("retry");
    expect(part.attempt).toBe(2);
    expect(part.error.name).toBe("APIError");
    expect(part.error.data.isRetryable).toBe(true);
    expect(part.time.created).toBe(1000);
  });

  test("rejects missing attempt", () => {
    expect(() =>
      Message.RetryPart.parse({
        ...base,
        type: "retry",
        error: {
          name: "APIError",
          data: { message: "fail", isRetryable: false },
        },
        time: { created: 1000 },
      }),
    ).toThrow();
  });
});

describe("Message.ToolPart", () => {
  const toolBase = {
    ...base,
    type: "tool" as const,
    callID: "c-1",
    tool: "search",
  };

  test("parses with pending state", () => {
    const part = Message.ToolPart.parse({
      ...toolBase,
      state: { status: "pending", input: {} },
    });

    expect(part.type).toBe("tool");
    expect(part.state.status).toBe("pending");
  });

  test("parses with running state", () => {
    const part = Message.ToolPart.parse({
      ...toolBase,
      state: { status: "running", input: {}, time: { start: 0 } },
    });

    expect(part.state.status).toBe("running");
  });

  test("parses with completed state", () => {
    const part = Message.ToolPart.parse({
      ...toolBase,
      state: {
        status: "completed",
        input: {},
        output: "ok",
        title: "t",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    });

    expect(part.state.status).toBe("completed");
  });

  test("parses with error state", () => {
    const part = Message.ToolPart.parse({
      ...toolBase,
      state: {
        status: "error",
        input: {},
        error: "fail",
        time: { start: 0, end: 1 },
      },
    });

    expect(part.state.status).toBe("error");
  });

  test("rejects missing callID", () => {
    expect(() =>
      Message.ToolPart.parse({
        ...base,
        type: "tool",
        tool: "search",
        state: { status: "pending", input: {} },
      }),
    ).toThrow();
  });

  test("rejects wrong Tool.State status", () => {
    expect(() =>
      Message.ToolPart.parse({
        ...toolBase,
        state: { status: "done", input: {} },
      }),
    ).toThrow();
  });
});

describe("Message.SnapshotPart", () => {
  test("parses valid snapshot part", () => {
    const part = Message.SnapshotPart.parse({
      ...base,
      type: "snapshot",
      snapshot: '{"ctx":"data"}',
    });

    expect(part.type).toBe("snapshot");
    expect(part.snapshot).toBe('{"ctx":"data"}');
  });

  test("rejects missing snapshot", () => {
    expect(() => Message.SnapshotPart.parse({ ...base, type: "snapshot" })).toThrow();
  });
});

describe("Message.CompactionPart", () => {
  test("parses valid compaction part", () => {
    const part = Message.CompactionPart.parse({
      ...base,
      type: "compaction",
      auto: true,
    });

    expect(part.type).toBe("compaction");
    expect(part.auto).toBe(true);
  });

  test("rejects missing auto", () => {
    expect(() => Message.CompactionPart.parse({ ...base, type: "compaction" })).toThrow();
  });
});

describe("Message.Part", () => {
  test("rejects unknown type literal", () => {
    expect(() => Message.Part.parse({ ...base, type: "unknown" })).toThrow();
  });
});

const msgBase = { id: "msg-1", sessionID: "ses-1" };

describe("Message.UserMessage", () => {
  const validUser = {
    ...msgBase,
    role: "user" as const,
    time: { created: 1000 },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-4-20250514" },
  };

  test("parses valid minimal user message", () => {
    const msg = Message.UserMessage.parse(validUser);

    expect(msg.role).toBe("user");
    expect(msg.agent).toBe("build");
    expect(msg.system).toBeUndefined();
    expect(msg.tools).toBeUndefined();
    expect(msg.variant).toBeUndefined();
  });

  test("parses valid full user message with system, tools, variant", () => {
    const msg = Message.UserMessage.parse({
      ...validUser,
      system: "You are helpful.",
      tools: { search: true, write: false },
      variant: "fast",
    });

    expect(msg.system).toBe("You are helpful.");
    expect(msg.tools).toEqual({ search: true, write: false });
    expect(msg.variant).toBe("fast");
  });

  test("rejects missing agent", () => {
    const { agent: _, ...noAgent } = validUser;
    expect(() => Message.UserMessage.parse(noAgent)).toThrow();
  });

  test("rejects wrong role", () => {
    expect(() => Message.UserMessage.parse({ ...validUser, role: "assistant" })).toThrow();
  });
});

describe("Message.AssistantMessage", () => {
  const validAssistant = {
    ...msgBase,
    role: "assistant" as const,
    time: { created: 1000 },
    parentID: "msg-0",
    modelID: "claude-opus-4-20250514",
    providerID: "anthropic",
    agent: "build",
    path: { cwd: "/home", root: "/" },
    cost: 0.01,
    tokens: {
      input: 500,
      output: 200,
      reasoning: 0,
      cache: { read: 100, write: 50 },
    },
  };

  test("parses valid minimal assistant message", () => {
    const msg = Message.AssistantMessage.parse(validAssistant);

    expect(msg.role).toBe("assistant");
    expect(msg.parentID).toBe("msg-0");
    expect(msg.cost).toBe(0.01);
    expect(msg.tokens.cache.read).toBe(100);
    expect(msg.time.completed).toBeUndefined();
    expect(msg.finish).toBeUndefined();
  });

  test("rejects missing parentID", () => {
    const { parentID: _, ...noParent } = validAssistant;
    expect(() => Message.AssistantMessage.parse(noParent)).toThrow();
  });
});

describe("Message.Info", () => {
  test("rejects wrong role", () => {
    expect(() => Message.Info.parse({ ...msgBase, role: "system" })).toThrow();
  });
});

describe("Message.WithParts", () => {
  const userInfo = {
    ...msgBase,
    role: "user" as const,
    time: { created: 1000 },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-4-20250514" },
  };

  const textPart = {
    ...base,
    type: "text" as const,
    text: "hello",
  };

  test("parses valid WithParts", () => {
    const wp = Message.WithParts.parse({
      info: userInfo,
      parts: [textPart],
    });

    expect(wp.info.role).toBe("user");
    expect(wp.parts).toHaveLength(1);
    expect(wp.parts[0].type).toBe("text");
  });

  test("rejects missing info", () => {
    expect(() => Message.WithParts.parse({ parts: [textPart] })).toThrow();
  });

  test("rejects missing parts", () => {
    expect(() => Message.WithParts.parse({ info: userInfo })).toThrow();
  });
});
