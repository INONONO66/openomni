import { describe, expect, it, mock } from "bun:test";
import type { Tool } from "@openomni/protocol";
import type { PolicyRegistration, PolicyContext } from "../../../src/core/policy";
import { PolicyEngine } from "../../../src/core/policy";
import { createToolExecutor } from "../../../src/core/execution/tool-executor";

function newID(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2)}`;
}

describe("invoke.result middleware dispatch", () => {
  it("fires the middleware fn after tool execution with correct context", async () => {
    const toolOutput = "tool-output-value";
    const postToolFn = mock((_ctx: PolicyContext) => ({ action: "continue" as const }));

    const engine = PolicyEngine.create();
    engine.register({
      name: "test:invoke.result",
      timing: "invoke.result",
      priority: 100,
      fn: postToolFn,
    });

    const executor = createToolExecutor({
      toolExecutor: async (call) => ({
        id: newID("result"),
        toolCallId: call.id,
        output: toolOutput,
        isError: false,
      }),
      engine,
    });

    const call: Tool.Call = { id: "call-post-tool", tool: "bash", input: { command: "ls" } };
    await executor(call);

    expect(postToolFn).toHaveBeenCalledTimes(1);
    const calledCtx = postToolFn.mock.calls[0][0] as PolicyContext;
    expect(calledCtx.timing).toBe("invoke.result");
    expect(calledCtx.toolName).toBe("bash");
    expect(calledCtx.toolOutput).toBe(toolOutput);
  });

  it("forwards usage from getContext to tool middleware", async () => {
    const postToolFn = mock((_ctx: PolicyContext) => ({ action: "continue" as const }));

    const engine = PolicyEngine.create();
    engine.register({
      name: "test:invoke.result",
      timing: "invoke.result",
      priority: 100,
      fn: postToolFn,
    });

    const executor = createToolExecutor({
      toolExecutor: async (call) => ({
        id: newID("result"),
        toolCallId: call.id,
        output: "ok",
        isError: false,
      }),
      engine,
      getContext: () => ({
        steps: [],
        turnCount: 1,
        elapsedMs: 5,
        usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 },
      }),
    });

    await executor({ id: "call-usage", tool: "bash", input: { command: "ls" } });

    const calledCtx = postToolFn.mock.calls[0][0] as PolicyContext;
    expect(calledCtx.usage).toEqual({ inputTokens: 13, outputTokens: 8, totalTokens: 21 });
  });

  it("transform verdict modifies the tool output", async () => {
    const engine = PolicyEngine.create();
    engine.register({
      name: "test:transform",
      timing: "invoke.result",
      priority: 100,
      fn: () => ({
        action: "transform",
        input: { output: "modified-output" },
        reason: "modify-output",
        policyId: "test.transform",
      }),
    });

    const executor = createToolExecutor({
      toolExecutor: async (call) => ({
        id: newID("result"),
        toolCallId: call.id,
        output: "original-output",
        isError: false,
      }),
      engine,
    });

    const call: Tool.Call = { id: "call-transform", tool: "bash", input: { command: "ls" } };
    const result = await executor(call);

    expect(result.output).toBe("modified-output");
  });
});

describe("invoke.prepare middleware dispatch", () => {
  it("skip verdict prevents tool execution", async () => {
    const baseExecutor = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: newID("result"),
        toolCallId: call.id,
        output: "executed",
        isError: false,
      }),
    );

    const engine = PolicyEngine.create();
    engine.register({
      name: "test:skip",
      timing: "invoke.prepare",
      priority: 100,
      fn: () => ({ action: "skip", reason: "test-skip" }),
    });

    const executor = createToolExecutor({ toolExecutor: baseExecutor, engine });

    const call: Tool.Call = { id: "call-skip", tool: "bash", input: { command: "ls" } };
    const result = await executor(call);

    expect(baseExecutor).toHaveBeenCalledTimes(0);
    expect(result.output).toContain("Skipped");
    expect(result.isError).toBe(false);
  });

  it("abort verdict prevents tool execution with isError", async () => {
    const baseExecutor = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: newID("result"),
        toolCallId: call.id,
        output: "executed",
        isError: false,
      }),
    );

    const engine = PolicyEngine.create();
    engine.register({
      name: "test:abort",
      timing: "invoke.prepare",
      priority: 100,
      fn: () => ({ action: "abort", reason: "Blocked: test-deny" }),
    });

    const executor = createToolExecutor({ toolExecutor: baseExecutor, engine });

    const call: Tool.Call = { id: "call-abort", tool: "bash", input: { command: "rm -rf /" } };
    const result = await executor(call);

    expect(baseExecutor).toHaveBeenCalledTimes(0);
    expect(result.output).toContain("Blocked");
    expect(result.isError).toBe(true);
  });

  it("transform verdict modifies tool input", async () => {
    let receivedInput: Record<string, unknown> | undefined;
    const baseExecutor = async (call: Tool.Call): Promise<Tool.Result> => {
      receivedInput = call.input;
      return { id: newID("result"), toolCallId: call.id, output: "ok", isError: false };
    };

    const engine = PolicyEngine.create();
    engine.register({
      name: "test:transform-input",
      timing: "invoke.prepare",
      priority: 100,
      fn: () => ({
        action: "transform",
        input: { command: "echo safe" },
        reason: "rewrite-input",
        policyId: "test.transform-input",
      }),
    });

    const executor = createToolExecutor({ toolExecutor: baseExecutor, engine });

    const call: Tool.Call = { id: "call-xform", tool: "bash", input: { command: "rm -rf /" } };
    await executor(call);

    expect(receivedInput).toEqual({ command: "echo safe" });
  });
});

describe("error middleware dispatch (stream-engine level)", () => {
  it("error middleware is registered and dispatchable", async () => {
    const onErrorFn = mock((_ctx: PolicyContext) => ({
      action: "abort" as const,
      reason: "test-error-abort",
      policyId: "test.on-error",
    }));

    const engine = PolicyEngine.create();
    engine.register({
      name: "test:error",
      timing: "error",
      priority: 100,
      fn: onErrorFn,
    });

    const error = new Error("test-error");
    const verdict = await engine.dispatchLegacy("error", {
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
      toolInput: { error },
    });

    expect(onErrorFn).toHaveBeenCalledTimes(1);
    expect(verdict.action).toBe("abort");
    const calledCtx = onErrorFn.mock.calls[0][0] as PolicyContext;
    expect(calledCtx.timing).toBe("error");
    expect(calledCtx.toolInput?.error).toBe(error);
  });
});

describe("idle-nudge invoke.result integration", () => {
  it("idle-nudge fn is dispatched for invoke.result timing", async () => {
    const { createIdleNudgePolicy } = await import("../../../src/core/policy/builtin/idle-nudge");

    const idleNudge = createIdleNudgePolicy({ idleThresholdMs: -1 });
    let postToolUseCallCount = 0;
    const originalFn = idleNudge.fn;
    const spiedIdleNudge: PolicyRegistration = {
      ...idleNudge,
      fn: (ctx: PolicyContext) => {
        if (ctx.timing === "invoke.result") postToolUseCallCount++;
        return originalFn(ctx);
      },
    };

    const engine = PolicyEngine.create();
    engine.register(spiedIdleNudge);

    const executor = createToolExecutor({
      toolExecutor: async (call) => ({
        id: newID("result"),
        toolCallId: call.id,
        output: "ok",
        isError: false,
      }),
      engine,
    });

    const call: Tool.Call = { id: "call-idle", tool: "bash", input: { command: "ls" } };
    await executor(call);

    expect(postToolUseCallCount).toBe(1);
  });
});
