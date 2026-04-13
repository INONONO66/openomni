import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Run, Sink, Tool } from "@openomni/protocol";
import type { AgentEvent } from "../../src/core/types";
import {
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../helpers/mock-llm";

let mockRunFn: MockLlmFn = async () => createStopOutcome();

mock.module("@openomni/llm", () => ({
  ModelsDev: { get: mock(async () => mockProviderData) },
  Provider: { fromModelsDevModel: mock(() => mockProviderModel) },
  run: (input: unknown, sink: Sink) => mockRunFn(input, sink),
  TokenTracker: {
    extractUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
  },
  ProviderTransform: {
    resolveVariant: () => ({}),
  },
}));

let ChatAgent: typeof import("../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../src/core/chat-agent"));
});

function resetMockRunFn() {
  mockRunFn = async () => createStopOutcome();
}

function newID(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2)}`;
}

function createAssistantMessage(text: string) {
  return {
    info: {
      id: `msg-${Math.random().toString(16).slice(2)}`,
      sessionID: "hooks-test",
      role: "assistant" as const,
      time: { created: Date.now() },
      parentID: "",
      modelID: "claude-3-haiku-20240307",
      providerID: "anthropic",
      agent: "hooks-test",
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
        id: `part-${Math.random().toString(16).slice(2)}`,
        sessionID: "hooks-test",
        messageID: "msg",
        type: "text" as const,
        text,
      },
    ],
  };
}

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("Execution hooks", () => {
  it("preToolUse skip returns skipped result without executing tool", async () => {
    resetMockRunFn();
    const executor = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: newID("result"),
        toolCallId: call.id,
        output: "executed",
        isError: false,
      }),
    );

    let observedToolResult: Tool.Result | undefined;
    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const runInput = input as { toolExecutor?: (call: Tool.Call) => Promise<Tool.Result> };
      const call: Tool.Call = { id: "call-skip", tool: "bash", input: { command: "ls" } };
      sink.onToolCall(call);
      const result = await runInput.toolExecutor!(call);
      sink.onToolResult(result);
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      tools: [{ name: "bash", inputSchema: { type: "object", properties: {} } }],
      toolExecutor: executor,
      hooks: {
        preToolUse: () => ({ action: "skip", reason: "policy" }),
      },
    });

    await agent.run(
      { messages: [{ role: "user", content: "run tool" }] },
      {
        onMessage: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (result) => {
          observedToolResult = result;
        },
        onSnapshot: () => undefined,
      },
    );

    expect(executor).toHaveBeenCalledTimes(0);
    expect(observedToolResult?.isError).toBe(false);
    expect(String(observedToolResult?.output)).toContain("[Skipped: policy]");
  });

  it("preToolUse transform executes with transformed input", async () => {
    resetMockRunFn();
    let receivedInput: Record<string, unknown> | undefined;
    const executor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      receivedInput = call.input;
      return {
        id: newID("result"),
        toolCallId: call.id,
        output: "ok",
        isError: false,
      };
    });

    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const runInput = input as { toolExecutor?: (call: Tool.Call) => Promise<Tool.Result> };
      const call: Tool.Call = { id: "call-transform", tool: "bash", input: { command: "ls" } };
      sink.onToolCall(call);
      const result = await runInput.toolExecutor!(call);
      sink.onToolResult(result);
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      tools: [{ name: "bash", inputSchema: { type: "object", properties: {} } }],
      toolExecutor: executor,
      hooks: {
        preToolUse: () => ({ action: "transform", input: { command: "pwd" } }),
      },
    });

    await agent.run({ messages: [{ role: "user", content: "run tool" }] });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(receivedInput).toEqual({ command: "pwd" });
  });

  it("postTurn inject continues with injected message", async () => {
    resetMockRunFn();
    let callCount = 0;
    mockRunFn = async (_input, sink): Promise<Run.Outcome> => {
      callCount++;
      sink.onMessage(createAssistantMessage(`turn-${callCount}`));
      return createStopOutcome();
    };

    let postTurnCalls = 0;
    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      hooks: {
        postTurn: () => {
          postTurnCalls++;
          return postTurnCalls === 1
            ? { action: "inject", message: "continue please" }
            : { action: "continue" };
        },
      },
    });

    const result = await agent.run({ messages: [{ role: "user", content: "hello" }] });
    expect(result.finishReason).toBe("stop");
    expect(result.guardAborted).toBeUndefined();
    expect(callCount).toBe(2);
  });

  it("postTurn abort stops with guardAborted=true", async () => {
    resetMockRunFn();
    mockRunFn = async (_input, sink): Promise<Run.Outcome> => {
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      hooks: {
        postTurn: () => ({ action: "abort", reason: "stop now" }),
      },
    });

    const result = await agent.run({ messages: [{ role: "user", content: "hello" }] });
    expect(result.finishReason).toBe("stop");
    expect(result.guardAborted).toBe(true);
  });

  it("hook throws are treated as continue without crashing", async () => {
    resetMockRunFn();
    const globalObj = globalThis as unknown as {
      console: { warn: (...args: unknown[]) => void };
    };
    const originalWarn = globalObj.console.warn;
    const warnSpy = mock(() => undefined);
    globalObj.console.warn = warnSpy;

    try {
      const executor = mock(
        async (call: Tool.Call): Promise<Tool.Result> => ({
          id: newID("result"),
          toolCallId: call.id,
          output: "executed",
          isError: false,
        }),
      );

      mockRunFn = async (input, sink): Promise<Run.Outcome> => {
        const runInput = input as { toolExecutor?: (call: Tool.Call) => Promise<Tool.Result> };
        const call: Tool.Call = { id: "call-throw", tool: "bash", input: { command: "ls" } };
        if (runInput.toolExecutor) {
          sink.onToolCall(call);
          const result = await runInput.toolExecutor(call);
          sink.onToolResult(result);
        }
        sink.onMessage(createAssistantMessage("done"));
        return createStopOutcome();
      };

      const agent = ChatAgent.create({
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        tools: [{ name: "bash", inputSchema: { type: "object", properties: {} } }],
        toolExecutor: executor,
        hooks: {
          preToolUse: () => {
            throw new Error("pre-tool-fail");
          },
          postTurn: () => {
            throw new Error("post-turn-fail");
          },
        },
      });

      const result = await agent.run({ messages: [{ role: "user", content: "hello" }] });
      expect(result.finishReason).toBe("stop");
      expect(executor).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      globalObj.console.warn = originalWarn;
    }
  });

  it("when hooks are not set, behavior remains unchanged", async () => {
    resetMockRunFn();
    let inputSeenByExecutor: Record<string, unknown> | undefined;
    const executor = mock(async (call: Tool.Call): Promise<Tool.Result> => {
      inputSeenByExecutor = call.input;
      return {
        id: newID("result"),
        toolCallId: call.id,
        output: "ok",
        isError: false,
      };
    });

    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const runInput = input as { toolExecutor?: (call: Tool.Call) => Promise<Tool.Result> };
      const call: Tool.Call = { id: "call-no-hooks", tool: "bash", input: { command: "ls" } };
      if (runInput.toolExecutor) {
        sink.onToolCall(call);
        const result = await runInput.toolExecutor(call);
        sink.onToolResult(result);
      }
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      tools: [{ name: "bash", inputSchema: { type: "object", properties: {} } }],
      toolExecutor: executor,
    });

    const result = await agent.run({ messages: [{ role: "user", content: "hello" }] });
    expect(result.finishReason).toBe("stop");
    expect(executor).toHaveBeenCalledTimes(1);
    expect(inputSeenByExecutor).toEqual({ command: "ls" });
  });

  it("hooks.postTurn takes precedence over stepGuard and warns", async () => {
    resetMockRunFn();
    const globalObj = globalThis as unknown as {
      console: { warn: (...args: unknown[]) => void };
    };
    const originalWarn = globalObj.console.warn;
    const warnSpy = mock(() => undefined);
    globalObj.console.warn = warnSpy;

    try {
      mockRunFn = async (_input, sink): Promise<Run.Outcome> => {
        sink.onMessage(createAssistantMessage("done"));
        return createStopOutcome();
      };

      const stepGuard = mock(() => ({ action: "abort" as const }));
      const postTurn = mock(() => ({ action: "continue" as const }));

      const agent = ChatAgent.create({
        model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
        stepGuard,
        hooks: { postTurn },
      });

      const result = await agent.run({ messages: [{ role: "user", content: "hello" }] });
      expect(result.finishReason).toBe("stop");
      expect(result.guardAborted).toBeUndefined();
      expect(postTurn).toHaveBeenCalledTimes(1);
      expect(stepGuard).toHaveBeenCalledTimes(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      globalObj.console.warn = originalWarn;
    }
  });

  it("stream emits hook_verdict events for preToolUse and postTurn", async () => {
    resetMockRunFn();
    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const runInput = input as { toolExecutor?: (call: Tool.Call) => Promise<Tool.Result> };
      const call: Tool.Call = { id: "call-stream", tool: "bash", input: { command: "ls" } };
      if (runInput.toolExecutor) {
        sink.onToolCall(call);
        const result = await runInput.toolExecutor(call);
        sink.onToolResult(result);
      }
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      tools: [{ name: "bash", inputSchema: { type: "object", properties: {} } }],
      toolExecutor: async (call) => ({
        id: newID("result"),
        toolCallId: call.id,
        output: "ok",
        isError: false,
      }),
      hooks: {
        preToolUse: () => ({ action: "skip", reason: "hook-skip" }),
        postTurn: () => ({ action: "continue" }),
      },
    });

    const events = await collectEvents(
      agent.stream({ messages: [{ role: "user", content: "hello" }] }),
    );
    const hookEvents = events.filter((e) => e.type === "hook_verdict");

    expect(hookEvents).toHaveLength(2);
    const pre = hookEvents.find(
      (e): e is Extract<AgentEvent, { type: "hook_verdict" }> =>
        e.type === "hook_verdict" && e.timing === "pre_tool_use",
    );
    const post = hookEvents.find(
      (e): e is Extract<AgentEvent, { type: "hook_verdict" }> =>
        e.type === "hook_verdict" && e.timing === "post_turn",
    );

    expect(pre?.action).toBe("skip");
    expect(pre?.reason).toBe("hook-skip");
    expect(post?.action).toBe("continue");
  });
});
