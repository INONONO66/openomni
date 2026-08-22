import { describe, expect, it, mock } from "bun:test";
import type { Tool } from "@openomni/protocol";
import type { PolicyContext } from "../../../src/core/policy";
import { PolicyEngine } from "../../../src/core/policy";
import { createToolExecutor } from "../../../src/core/execution/tools";
import {
  registerAt,
  abortRun,
  allow,
  pending,
  rewriteToolInput,
  rewriteToolOutput,
} from "../../helpers/policy-decision";
import { Bus } from "@openomni/telemetry";

function newID(prefix: string): string {
  return `${prefix}-${Math.random().toString(16).slice(2)}`;
}

describe("tool.native.post middleware dispatch", () => {
  it("fires the middleware fn after tool execution with correct context", async () => {
    const toolOutput = "tool-output-value";
    const postToolFn = mock((_ctx: PolicyContext) => allow());

    const engine = PolicyEngine.create();
    registerAt(engine, "tool.native.post", "test:invoke.result", 100, postToolFn);

    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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
    const calledCtx = postToolFn.mock.calls[0]?.[0] as PolicyContext;
    expect(calledCtx.timing).toBe("invoke.result");
    expect(calledCtx.toolName).toBe("bash");
    expect(calledCtx.toolOutput).toBe(toolOutput);
  });

  it("forwards usage from getContext to tool middleware", async () => {
    const postToolFn = mock((_ctx: PolicyContext) => allow());

    const engine = PolicyEngine.create();
    registerAt(engine, "tool.native.post", "test:invoke.result", 100, postToolFn);

    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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

    const calledCtx = postToolFn.mock.calls[0]?.[0] as PolicyContext;
    expect(calledCtx.usage).toEqual({ inputTokens: 13, outputTokens: 8, totalTokens: 21 });
  });

  it("transform verdict modifies the tool output", async () => {
    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "tool.native.post",
      "test:transform",
      100,
      () => rewriteToolOutput("modified-output", "test.transform", "modify-output"),
      ["tool.rewrite_output"],
    );

    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
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

describe("tool.native.pre middleware dispatch", () => {
  it("pending approval decision prevents tool execution", async () => {
    const baseExecutor = mock(
      async (call: Tool.Call): Promise<Tool.Result> => ({
        id: newID("result"),
        toolCallId: call.id,
        output: "executed",
        isError: false,
      }),
    );

    const engine = PolicyEngine.create();
    registerAt(
      engine,
      "tool.native.pre",
      "test:approval",
      100,
      () =>
        pending("test.approval", "approval-required", [
          { type: "tool.require_approval", reason: "approval-required" },
        ]),
      ["tool.require_approval"],
    );

    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      toolExecutor: baseExecutor,
      engine,
    });

    const call: Tool.Call = { id: "call-approval", tool: "bash", input: { command: "ls" } };
    const result = await executor(call);

    expect(baseExecutor).toHaveBeenCalledTimes(0);
    // Audit M5: no approval flow is wired; the denial says so honestly
    // instead of wearing an approval costume.
    expect(result.output).toBe(
      "[Denied: approval-required — approval required, but no approval flow is wired; denied fail-closed]",
    );
    expect(result.isError).toBe(true);
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
    registerAt(
      engine,
      "tool.native.pre",
      "test:abort",
      100,
      () => abortRun("test.abort", "Blocked: test-deny"),
      ["run.abort"],
    );

    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      toolExecutor: baseExecutor,
      engine,
    });

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
    registerAt(
      engine,
      "tool.native.pre",
      "test:transform-input",
      100,
      () => rewriteToolInput({ command: "echo safe" }, "test.transform-input", "rewrite-input"),
      ["tool.rewrite_input"],
    );

    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      toolExecutor: baseExecutor,
      engine,
    });

    const call: Tool.Call = { id: "call-xform", tool: "bash", input: { command: "rm -rf /" } };
    await executor(call);

    expect(receivedInput).toEqual({ command: "echo safe" });
  });
});

describe("error middleware dispatch (runner level)", () => {
  it("error middleware is registered and dispatchable", async () => {
    const onErrorFn = mock((_ctx: PolicyContext) => abortRun("test.on-error", "test-error-abort"));

    const engine = PolicyEngine.create();
    registerAt(engine, "run.error.error", "test:error", 100, onErrorFn, ["run.abort"]);

    const verdict = await engine.dispatchPoint("run.error.error", {
      sessionId: "session",
      runId: "run",
      // Canonical run.error.error carries errorCode/errorPhase strings; Error
      // instances cannot cross the immutable point-context snapshot boundary.
      errorCode: "test-error",
      errorPhase: "turn",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turnCount: 0,
      isCompletion: false,
      continuationCount: 0,
      elapsedMs: 0,
    });

    expect(onErrorFn).toHaveBeenCalledTimes(1);
    expect(verdict.verdict).toBe("deny");
    const calledCtx = onErrorFn.mock.calls[0]?.[0] as PolicyContext & {
      errorCode?: string;
      errorPhase?: string;
    };
    expect(calledCtx.timing).toBe("error");
    expect(calledCtx.errorCode).toBe("test-error");
    expect(calledCtx.errorPhase).toBe("turn");
  });
});
