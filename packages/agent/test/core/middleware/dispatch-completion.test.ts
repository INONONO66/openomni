import { beforeAll, describe, expect, it, mock } from "bun:test";
import type { Run, Sink, Tool } from "@openomni/protocol";
import type { AgentResult } from "../../../src/core/types";
import type { MiddlewareRegistration, MiddlewareContext } from "../../../src/core/middleware";
import { createIdleNudgeMiddleware } from "../../../src/core/middleware/builtin";
import {
  createStopOutcome,
  mockProviderData,
  mockProviderModel,
  type MockLlmFn,
} from "../../helpers/mock-llm";

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

let ChatAgent: typeof import("../../../src/core/chat-agent").ChatAgent;

beforeAll(async () => {
  ({ ChatAgent } = await import("../../../src/core/chat-agent"));
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
      sessionID: "dispatch-test",
      role: "assistant" as const,
      time: { created: Date.now() },
      parentID: "",
      modelID: "claude-3-haiku-20240307",
      providerID: "anthropic",
      agent: "dispatch-test",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: `part-${Math.random().toString(16).slice(2)}`,
        sessionID: "dispatch-test",
        messageID: "msg",
        type: "text" as const,
        text,
      },
    ],
  };
}

describe("post_tool_use middleware dispatch", () => {
  it("fires the middleware fn after tool execution with correct context", async () => {
    resetMockRunFn();
    const toolOutput = "tool-output-value";
    const postToolFn = mock((_ctx: MiddlewareContext) => ({ action: "continue" as const }));

    const postToolMiddleware: MiddlewareRegistration = {
      name: "test:post_tool_use",
      timing: "post_tool_use",
      priority: 100,
      fn: postToolFn,
    };

    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const runInput = input as { toolExecutor?: (call: Tool.Call) => Promise<Tool.Result> };
      const call: Tool.Call = { id: "call-post-tool", tool: "bash", input: { command: "ls" } };
      sink.onToolCall(call);
      const result = await runInput.toolExecutor!(call);
      sink.onToolResult(result);
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      tools: [{ name: "bash", inputSchema: { type: "object", properties: {} } }],
      toolExecutor: async (call) => ({
        id: newID("result"),
        toolCallId: call.id,
        output: toolOutput,
        isError: false,
      }),
      middleware: [postToolMiddleware],
    });

    await agent.run({ messages: [{ role: "user", content: "run tool" }] });

    expect(postToolFn).toHaveBeenCalledTimes(1);
    const calledCtx = postToolFn.mock.calls[0][0] as MiddlewareContext;
    expect(calledCtx.timing).toBe("post_tool_use");
    expect(calledCtx.toolName).toBe("bash");
    expect(calledCtx.toolOutput).toBe(toolOutput);
  });

  it("transform verdict modifies the tool output seen by the LLM", async () => {
    resetMockRunFn();
    let capturedToolResult: Tool.Result | undefined;

    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const runInput = input as { toolExecutor?: (call: Tool.Call) => Promise<Tool.Result> };
      const call: Tool.Call = { id: "call-transform", tool: "bash", input: { command: "ls" } };
      sink.onToolCall(call);
      capturedToolResult = await runInput.toolExecutor!(call);
      sink.onToolResult(capturedToolResult);
      sink.onMessage(createAssistantMessage("done"));
      return createStopOutcome();
    };

    const transformMiddleware: MiddlewareRegistration = {
      name: "test:transform",
      timing: "post_tool_use",
      priority: 100,
      fn: () => ({ action: "transform", input: { output: "modified-output" } }),
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      tools: [{ name: "bash", inputSchema: { type: "object", properties: {} } }],
      toolExecutor: async (call) => ({
        id: newID("result"),
        toolCallId: call.id,
        output: "original-output",
        isError: false,
      }),
      middleware: [transformMiddleware],
    });

    await agent.run({ messages: [{ role: "user", content: "run tool" }] });

    expect(capturedToolResult?.output).toBe("modified-output");
  });
});

describe("on_error middleware dispatch", () => {
  it("fires the middleware fn with error in context when llmRun throws", async () => {
    resetMockRunFn();
    const testError = new Error("llm-failure");
    const onErrorFn = mock((_ctx: MiddlewareContext) => ({ action: "abort" as const }));

    mockRunFn = async (): Promise<Run.Outcome> => {
      throw testError;
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      middleware: [
        {
          name: "test:on_error",
          timing: "on_error",
          priority: 100,
          fn: onErrorFn,
        },
      ],
    });

    // swallow throw so assertions run even when dispatch is not yet wired
    await agent.run({ messages: [{ role: "user", content: "hello" }] }).catch(() => undefined);

    expect(onErrorFn).toHaveBeenCalledTimes(1);
    const calledCtx = onErrorFn.mock.calls[0][0] as MiddlewareContext;
    expect(calledCtx.timing).toBe("on_error");
    // error is carried via toolInput.error — matches compat.ts on_error convention
    expect(calledCtx.toolInput?.error).toBe(testError);
  });

  it("abort verdict stops the agent cleanly instead of rethrowing", async () => {
    resetMockRunFn();

    mockRunFn = async (): Promise<Run.Outcome> => {
      throw new Error("unexpected-failure");
    };

    const agent = ChatAgent.create({
      model: { provider: "anthropic", id: "claude-3-haiku-20240307" },
      middleware: [
        {
          name: "test:on_error-abort",
          timing: "on_error",
          priority: 100,
          fn: () => ({ action: "abort" as const }),
        },
      ],
    });

    let result: AgentResult | undefined;
    let caughtError: Error | undefined;
    try {
      result = await agent.run({ messages: [{ role: "user", content: "hello" }] });
    } catch (e) {
      caughtError = e as Error;
    }

    expect(caughtError).toBeUndefined();
    expect(result?.guardAborted).toBe(true);
  });
});

describe("idle-nudge post_tool_use integration", () => {
  it("idle-nudge fn is dispatched for post_tool_use timing when a tool executes", async () => {
    resetMockRunFn();

    const idleNudge = createIdleNudgeMiddleware({ idleThresholdMs: -1 });
    let postToolUseCallCount = 0;
    const originalFn = idleNudge.fn;
    const spiedIdleNudge: MiddlewareRegistration = {
      ...idleNudge,
      fn: (ctx: MiddlewareContext) => {
        if (ctx.timing === "post_tool_use") postToolUseCallCount++;
        return originalFn(ctx);
      },
    };

    mockRunFn = async (input, sink): Promise<Run.Outcome> => {
      const runInput = input as { toolExecutor?: (call: Tool.Call) => Promise<Tool.Result> };
      const call: Tool.Call = { id: "call-idle", tool: "bash", input: { command: "ls" } };
      sink.onToolCall(call);
      const result = await runInput.toolExecutor!(call);
      sink.onToolResult(result);
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
      middleware: [spiedIdleNudge],
    });

    await agent.run({ messages: [{ role: "user", content: "run tool" }] });

    expect(postToolUseCallCount).toBe(1);
  });
});
