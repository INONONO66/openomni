import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Message, Run, Sink, Tool } from "@openomni/protocol";
import type { AgentEvent, AgentStep } from "../src/core/types";
import {
  createStopOutcome,
  createMockLlmConfig,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "./helpers/mock-llm";
import { allow, continueWithPrompt } from "./helpers/policy-decision";
import { runInput } from "./helpers/run-input";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

const mockModelsGet = mock(async () => mockProviderData);
const mockProviderFromModelsDevModel = mock(() => mockProviderModel);

const mockLlm = createMockLlmConfig({
  getModels: mockModelsGet,
  fromModelsDevModel: mockProviderFromModelsDevModel,
  run: (input, sink: Sink) => mockRunFn(input, sink),
});

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
    llm: mockLlm,
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

    const result = await createAgent().run(runInput([{ role: "user", content: "Hello" }]));

    expect(result.finishReason).toBe("stop");
    expect(result.text).toBe("Hello!");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.type).toBe("text");
  });

  it("stops with max-steps when maxTurns budget is exceeded", async () => {
    let callCount = 0;
    mockRunFn = async (_input, sink): Promise<Run.Outcome> => {
      callCount += 1;
      sink.onMessage(createAssistantMessage("turn complete"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm,
      budget: { maxTurns: 1, maxToolCalls: 10 },
      middleware: [
        {
          kind: "point",
          name: "test:inject-continue",
          pointIds: ["run.turn.post"],
          effectCapabilities: { "run.turn.post": ["run.continue_with_prompt"] },
          priority: 250,
          fn: async () => continueWithPrompt("continue", "test.step-guard", "continue-after-step"),
        },
      ],
    });

    const result = await agent.run(runInput([{ role: "user", content: "Loop" }]));

    expect(result.finishReason).toBe("max-steps");
    expect(callCount).toBe(1);
  });

  it("passes maxToolCalls budget as maxSteps into llm run", async () => {
    let observedMaxSteps: number | undefined;
    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      observedMaxSteps = input.maxSteps;
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm,
      budget: { maxTurns: 10, maxToolCalls: 7 },
    });

    const result = await agent.run(runInput([{ role: "user", content: "Loop with tools" }]));

    expect(result.finishReason).toBe("stop");
    expect(observedMaxSteps).toBe(7);
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
      llm: mockLlm,
      signal: controller.signal,
    });

    let abortError: unknown;
    try {
      await agent.run(runInput([{ role: "user", content: "Hello" }]));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      abortError = error;
    }

    expect(abortError).toBeInstanceOf(Error);
    expect((abortError as Error).message).toContain("aborted");
    expect(callCount).toBe(0);
  });

  it("calls onStepFinish after each step", async () => {
    let guardInvocations = 0;
    let callCount = 0;
    mockRunFn = async (_input, sink): Promise<Run.Outcome> => {
      callCount += 1;
      sink.onMessage(createAssistantMessage(`turn-${callCount}`));
      return createStopOutcome();
    };

    const stepFinishCalls: AgentStep[] = [];
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      llm: mockLlm,
      onStepFinish: (step) => {
        stepFinishCalls.push(step);
      },
      middleware: [
        {
          kind: "point",
          name: "test:conditional-inject",
          pointIds: ["run.turn.post"],
          effectCapabilities: { "run.turn.post": ["run.continue_with_prompt"] },
          priority: 250,
          fn: async () => {
            guardInvocations += 1;
            if (guardInvocations === 1) {
              return continueWithPrompt("continue", "test.step-guard", "continue-after-step");
            }
            return allow("test.step-guard");
          },
        },
      ],
    });

    await agent.run(runInput([{ role: "user", content: "Hello" }]));

    expect(stepFinishCalls).toHaveLength(2);
    expect(stepFinishCalls[0]?.type).toBe("text");
    expect(stepFinishCalls[1]?.type).toBe("text");
  });

  it("retries transient errors up to the default max attempts", async () => {
    let attempts = 0;
    mockRunFn = async () => {
      attempts += 1;
      throw new Error("transient network error");
    };

    let retryError: unknown;
    try {
      await createAgent().run(runInput([{ role: "user", content: "Hello" }]));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      retryError = error;
    }

    expect(retryError).toBeInstanceOf(Error);
    expect((retryError as Error).message).toContain("transient network error");
    expect(attempts).toBe(3);
  });
});

it("uses toolExecutor when provided to execute tool calls", async () => {
  const toolExecutorCalls: Tool.Call[] = [];
  const executor = async (call: Tool.Call) => {
    toolExecutorCalls.push(call);
    return {
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: "real result from executor",
      isError: false,
    };
  };

  mockRunFn = async (input, sink): Promise<Run.Outcome> => {
    const call = createToolCall("call-1", "custom_tool");
    if (input.toolExecutor) {
      const result = await input.toolExecutor(call);
      sink.onToolCall(call);
      sink.onToolResult(result);
    }
    sink.onMessage(createAssistantMessage("done"));
    return createStopOutcome();
  };

  const agent = ChatAgent.create({
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    llm: mockLlm,
    toolExecutor: executor,
  });

  const result = await agent.run(runInput([{ role: "user", content: "Use a tool" }]));

  expect(toolExecutorCalls).toHaveLength(1);
  expect(toolExecutorCalls[0]?.tool).toBe("custom_tool");
  expect(result.finishReason).toBe("stop");
});

it("passes the agent abort signal to toolExecutor calls", async () => {
  let capturedSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const executor = async (_call: Tool.Call, context?: Tool.ExecutionContext) => {
    capturedSignal = context?.signal;
    return {
      id: crypto.randomUUID(),
      toolCallId: "call-1",
      output: "signal captured",
      isError: false,
    };
  };

  mockRunFn = async (input, sink): Promise<Run.Outcome> => {
    const call = createToolCall("call-1", "custom_tool");
    if (!input.toolExecutor) throw new Error("expected tool executor");
    const result = await input.toolExecutor(call);
    sink.onToolCall(call);
    sink.onToolResult(result);
    sink.onMessage(createAssistantMessage("done"));
    return createStopOutcome();
  };

  const agent = ChatAgent.create({
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    llm: mockLlm,
    signal: controller.signal,
    toolExecutor: executor,
  });

  await agent.run(runInput([{ role: "user", content: "Use a tool" }]));

  expect(capturedSignal).toBe(controller.signal);
});

it("handles toolExecutor errors by setting isError: true", async () => {
  mockRunFn = async (input, sink): Promise<Run.Outcome> => {
    const call = createToolCall("call-1", "failing_tool");
    if (input.toolExecutor) {
      try {
        await input.toolExecutor(call);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const result = {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: error.message,
          isError: true,
        };
        sink.onToolCall(call);
        sink.onToolResult(result);
      }
    }
    sink.onMessage(createAssistantMessage("handled error"));
    return createStopOutcome();
  };

  const agent = ChatAgent.create({
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    llm: mockLlm,
    toolExecutor: async () => {
      throw new Error("Tool execution failed: database connection lost");
    },
  });

  const result = await agent.run(runInput([{ role: "user", content: "Use a tool" }]));

  expect(result.finishReason).toBe("stop");
});

it("throws when tools are configured without toolExecutor", async () => {
  const agent = ChatAgent.create({
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    llm: mockLlm,
    tools: [
      {
        name: "stub_tool",
        description: "stub",
        inputSchema: { type: "object", properties: {}, required: [] },
        safe: true,
      },
    ],
  });

  await expect(agent.run(runInput([{ role: "user", content: "Use a tool" }]))).rejects.toThrow(
    "toolExecutor is required when tools are provided",
  );
});

it("does not retry missing toolExecutor configuration errors", async () => {
  const agent = ChatAgent.create({
    model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
    llm: mockLlm,
    tools: [
      {
        name: "stub_tool",
        description: "stub",
        inputSchema: { type: "object", properties: {}, required: [] },
        safe: true,
      },
    ],
  });

  const events: AgentEvent[] = [];
  let configurationError: unknown;
  try {
    for await (const event of agent.stream(runInput([{ role: "user", content: "Use a tool" }]))) {
      events.push(event);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    configurationError = error;
  }

  expect(configurationError).toBeInstanceOf(Error);
  expect((configurationError as Error).message).toContain(
    "toolExecutor is required when tools are provided",
  );
  expect(events.filter((event) => event.type === "error" && event.willRetry)).toHaveLength(0);
});
