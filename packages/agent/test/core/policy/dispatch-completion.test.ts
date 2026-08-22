import { describe, expect, it, mock } from "bun:test";
import type { Policy, Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createToolExecutor } from "../../../src/core/execution/tools";
import { PolicyEngine, type PolicyContext, type PolicyFn } from "../../../src/core/policy";
import {
  abortRun,
  allow,
  pending,
  policyContext,
  registerAt,
  rewriteToolInput,
  rewriteToolOutput,
} from "../../helpers/policy-decision";

const call: Tool.Call = { id: "call", tool: "bash", input: { command: "ls" } };

function toolHarness(options: {
  point: "tool.native.pre" | "tool.native.post";
  fn: PolicyFn;
  effects?: Policy.PolicyEffectType[];
  execute?: (call: Tool.Call) => Promise<Tool.Result>;
  getContext?: () => Pick<PolicyContext, "steps" | "turnCount" | "elapsedMs" | "usage">;
}) {
  const engine = PolicyEngine.create();
  registerAt(engine, options.point, "test:policy", 100, options.fn, options.effects);
  const execute =
    options.execute ??
    mock(
      async (item: Tool.Call): Promise<Tool.Result> => ({
        id: "result",
        toolCallId: item.id,
        output: "tool-output-value",
        isError: false,
      }),
    );
  const executor = createToolExecutor({
    events: Bus,
    traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
    toolExecutor: execute,
    engine,
    ...(options.getContext && { getContext: options.getContext }),
  });
  return { execute, executor };
}

describe("tool.native.post middleware dispatch", () => {
  it("fires after execution with the tool context", async () => {
    const post = mock((_ctx: PolicyContext) => allow());
    const { executor } = toolHarness({ point: "tool.native.post", fn: post });
    await executor(call);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({
      timing: "invoke.result",
      toolName: "bash",
      toolOutput: "tool-output-value",
    });
  });

  it("forwards usage from getContext", async () => {
    const post = mock((_ctx: PolicyContext) => allow());
    const usage = { inputTokens: 13, outputTokens: 8, totalTokens: 21 };
    const { executor } = toolHarness({
      point: "tool.native.post",
      fn: post,
      getContext: () => ({ ...policyContext(), turnCount: 1, elapsedMs: 5, usage }),
    });
    await executor(call);
    expect(post.mock.calls[0]?.[0].usage).toEqual(usage);
  });

  it("applies output rewrites", async () => {
    const { executor } = toolHarness({
      point: "tool.native.post",
      fn: () => rewriteToolOutput("modified-output", "test.transform", "modify-output"),
      effects: ["tool.rewrite_output"],
    });
    expect((await executor(call)).output).toBe("modified-output");
  });
});

describe("tool.native.pre middleware dispatch", () => {
  it("fails closed when approval is pending", async () => {
    const { execute, executor } = toolHarness({
      point: "tool.native.pre",
      fn: () =>
        pending("test.approval", "approval-required", [
          { type: "tool.require_approval", reason: "approval-required" },
        ]),
      effects: ["tool.require_approval"],
    });
    const result = await executor(call);
    expect(execute).toHaveBeenCalledTimes(0);
    expect(result.output).toBe(
      "[Denied: approval-required — approval required, but no approval flow is wired; denied fail-closed]",
    );
    expect(result.isError).toBe(true);
  });

  it("prevents execution on abort", async () => {
    const { execute, executor } = toolHarness({
      point: "tool.native.pre",
      fn: () => abortRun("test.abort", "Blocked: test-deny"),
      effects: ["run.abort"],
    });
    const result = await executor({ ...call, input: { command: "rm -rf /" } });
    expect(execute).toHaveBeenCalledTimes(0);
    expect(result.output).toContain("Blocked");
    expect(result.isError).toBe(true);
  });

  it("applies input rewrites", async () => {
    let receivedInput: Record<string, unknown> | undefined;
    const { executor } = toolHarness({
      point: "tool.native.pre",
      fn: () => rewriteToolInput({ command: "echo safe" }, "test.transform-input", "rewrite-input"),
      effects: ["tool.rewrite_input"],
      execute: async (item) => {
        receivedInput = item.input;
        return { id: "result", toolCallId: item.id, output: "ok", isError: false };
      },
    });
    await executor(call);
    expect(receivedInput).toEqual({ command: "echo safe" });
  });
});

it("dispatches run errors with canonical context", async () => {
  const onError = mock((_ctx: PolicyContext) => abortRun("test.on-error", "test-error-abort"));
  const engine = PolicyEngine.create();
  registerAt(engine, "run.error.error", "test:error", 100, onError, ["run.abort"]);
  const verdict = await engine.dispatchPoint("run.error.error", {
    ...policyContext(),
    sessionId: "session",
    runId: "run",
    errorCode: "test-error",
    errorPhase: "turn",
  });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(verdict.verdict).toBe("deny");
  expect(onError.mock.calls[0]?.[0]).toMatchObject({
    timing: "error",
    errorCode: "test-error",
    errorPhase: "turn",
  });
});
