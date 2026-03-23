import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";
import type { AgentStep } from "../src/core/types";
import {
  createStopOutcome,
  createToolCallOutcome,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "./helpers/mock-llm";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

const mockModelsGet = mock(async () => mockProviderData);
const mockProviderFromModelsDevModel = mock(() => mockProviderModel);

mock.module("@openomni/llm", () => ({
  ModelsDev: {
    get: mockModelsGet,
  },
  Provider: {
    fromModelsDevModel: mockProviderFromModelsDevModel,
  },
  run: (input: unknown, sink: Sink) => mockRunFn(input, sink),
}));

let ChatAgent: typeof import("../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../src/core/chat-agent"));
});

function createToolCall(id: string, tool = "test_tool"): Tool.Call {
  return { id, tool, input: {} };
}

function createAssistantMessage(text: string): Message.WithParts {
  const id = `msg-${crypto.randomUUID()}`;
  const sessionID = "chat-agent-test";
  const now = Date.now();

  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: now },
      parentID: "",
      modelID: "claude-3-haiku-20240307",
      providerID: "anthropic",
      agent: "chat-agent",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: `part-${crypto.randomUUID()}`,
        sessionID,
        messageID: id,
        type: "text",
        text,
      },
    ],
  };
}

function createAgent() {
  return ChatAgent.create({
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
  });
}

describe("ChatAgent", () => {
  beforeEach(() => {
    mockRunFn = async () => createStopOutcome();
    mockModelsGet.mockClear();
    mockProviderFromModelsDevModel.mockClear();
  });

  it("create() returns instance with run and stream methods", () => {
    const agent = createAgent();

    expect(typeof agent.run).toBe("function");
    expect(typeof agent.stream).toBe("function");
  });

  it("run() returns finishReason stop when LLM stops", async () => {
    mockRunFn = async (_input, sink) => {
      sink.onMessage(createAssistantMessage("Hello!"));
      return createStopOutcome();
    };

    const result = await createAgent().run({
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("Hello!");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.type).toBe("text");
  });

  it("run() executes tools and loops until stop", async () => {
    let callCount = 0;
    mockRunFn = async (_input, sink): Promise<Run.Outcome> => {
      callCount += 1;
      if (callCount === 1) {
        const call = createToolCall("call-1");
        sink.onToolCall(call);
        return createToolCallOutcome([call]);
      }

      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const result = await createAgent().run({
      messages: [{ role: "user", content: "Use a tool" }],
    });

    expect(result.finishReason).toBe("stop");
    expect(callCount).toBe(2);
    expect(result.steps.some((step) => step.type === "tool-call")).toBe(true);
    expect(result.text).toBe("done");
  });

  it("stops with max-steps when maxTurns budget is exceeded", async () => {
    let callCount = 0;
    mockRunFn = async (): Promise<Run.Outcome> => {
      callCount += 1;
      return createToolCallOutcome([createToolCall(`turn-${callCount}`)]);
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      budget: { maxTurns: 1, maxToolCalls: 10 },
    });

    const result = await agent.run({
      messages: [{ role: "user", content: "Loop" }],
    });

    expect(result.finishReason).toBe("max-steps");
    expect(callCount).toBe(1);
  });

  it("stops with max-steps when maxToolCalls budget is exceeded", async () => {
    let callCount = 0;
    mockRunFn = async (): Promise<Run.Outcome> => {
      callCount += 1;
      return createToolCallOutcome([createToolCall(`tool-${callCount}`)]);
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      budget: { maxTurns: 10, maxToolCalls: 1 },
    });

    const result = await agent.run({
      messages: [{ role: "user", content: "Loop with tools" }],
    });

    expect(result.finishReason).toBe("max-steps");
    expect(callCount).toBe(1);
  });

  it("respects AbortSignal cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    let callCount = 0;
    mockRunFn = async () => {
      callCount += 1;
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      signal: controller.signal,
    });

    let abortError: unknown;
    try {
      await agent.run({ messages: [{ role: "user", content: "Hello" }] });
    } catch (error) {
      abortError = error;
    }

    expect(abortError).toBeInstanceOf(Error);
    expect((abortError as Error).message).toContain("aborted");
    expect(callCount).toBe(0);
  });

  it("calls onStepFinish after each step", async () => {
    let callCount = 0;
    mockRunFn = async (): Promise<Run.Outcome> => {
      callCount += 1;
      if (callCount === 1) {
        return createToolCallOutcome([createToolCall("call-1")]);
      }
      return createStopOutcome();
    };

    const stepFinishCalls: AgentStep[] = [];
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      onStepFinish: (step) => {
        stepFinishCalls.push(step);
      },
    });

    await agent.run({ messages: [{ role: "user", content: "Hello" }] });

    expect(stepFinishCalls).toHaveLength(2);
    expect(stepFinishCalls[0]?.type).toBe("tool-call");
    expect(stepFinishCalls[1]?.type).toBe("text");
  });

  it("does not retry when transient errors happen with default policy", async () => {
    let attempts = 0;
    mockRunFn = async () => {
      attempts += 1;
      throw new Error("transient network error");
    };

    let retryError: unknown;
    try {
      await createAgent().run({
        messages: [{ role: "user", content: "Hello" }],
      });
    } catch (error) {
      retryError = error;
    }

    expect(retryError).toBeInstanceOf(Error);
    expect((retryError as Error).message).toContain("transient network error");
    expect(attempts).toBe(1);
  });

  it("keeps ChatAgent source free of session package dependency", async () => {
    const forbiddenImport = "@openomni/" + "session";
    const content = await readFile(
      new URL("../src/core/chat-agent.ts", import.meta.url),
      "utf8",
    );

    expect(content.includes(forbiddenImport)).toBe(false);
  });
});

it("uses toolExecutor when provided to execute tool calls", async () => {
  let callCount = 0;
  mockRunFn = async (_input, sink): Promise<Run.Outcome> => {
    callCount += 1;
    if (callCount === 1) {
      const call = createToolCall("call-1", "custom_tool");
      sink.onToolCall(call);
      return createToolCallOutcome([call]);
    }

    sink.onMessage(createAssistantMessage("done"));
    return createStopOutcome();
  };

  const toolExecutorCalls: Tool.Call[] = [];
  const agent = ChatAgent.create({
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    toolExecutor: async (call) => {
      toolExecutorCalls.push(call);
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: "real result from executor",
        isError: false,
      };
    },
  });

  const result = await agent.run({
    messages: [{ role: "user", content: "Use a tool" }],
  });

  expect(toolExecutorCalls).toHaveLength(1);
  expect(toolExecutorCalls[0]?.tool).toBe("custom_tool");
  expect(result.steps.some((step) => step.type === "tool-call")).toBe(true);
  const toolStep = result.steps.find((step) => step.type === "tool-call");
  expect(toolStep?.toolResults?.[0]?.output).toBe("real result from executor");
});

it("handles toolExecutor errors by setting isError: true", async () => {
  let callCount = 0;
  mockRunFn = async (_input, sink): Promise<Run.Outcome> => {
    callCount += 1;
    if (callCount === 1) {
      const call = createToolCall("call-1", "failing_tool");
      sink.onToolCall(call);
      return createToolCallOutcome([call]);
    }

    sink.onMessage(createAssistantMessage("handled error"));
    return createStopOutcome();
  };

  const agent = ChatAgent.create({
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    toolExecutor: async (call) => {
      throw new Error("Tool execution failed: database connection lost");
    },
  });

  const result = await agent.run({
    messages: [{ role: "user", content: "Use a tool" }],
  });

  const toolStep = result.steps.find((step) => step.type === "tool-call");
  expect(toolStep?.toolResults).toHaveLength(1);
  expect(toolStep?.toolResults?.[0]?.isError).toBe(true);
  expect(toolStep?.toolResults?.[0]?.output).toContain("Tool execution failed");
});

it("preserves stub behavior when toolExecutor is not provided", async () => {
  let callCount = 0;
  mockRunFn = async (_input, sink): Promise<Run.Outcome> => {
    callCount += 1;
    if (callCount === 1) {
      const call = createToolCall("call-1", "stub_tool");
      sink.onToolCall(call);
      return createToolCallOutcome([call]);
    }

    sink.onMessage(createAssistantMessage("done"));
    return createStopOutcome();
  };

  const agent = ChatAgent.create({
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    // No toolExecutor provided
  });

  const result = await agent.run({
    messages: [{ role: "user", content: "Use a tool" }],
  });

  const toolStep = result.steps.find((step) => step.type === "tool-call");
  expect(toolStep?.toolResults).toHaveLength(1);
  expect(toolStep?.toolResults?.[0]?.output).toContain(
    "Tool 'stub_tool' executed (no executor configured)",
  );
  expect(toolStep?.toolResults?.[0]?.isError).toBe(false);
});
