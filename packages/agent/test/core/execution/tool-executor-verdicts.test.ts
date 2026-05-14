import { describe, expect, it } from "bun:test";
import { ToolExecution, type Policy, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { createToolExecutor } from "../../../src/core/execution/tool-executor";
import { PolicyEngine, type PolicyRegistration } from "../../../src/core/policy";

type ResultWithMetadata = Tool.Result & {
  metadata?: {
    verdict?: string;
    reason?: string;
    retryAfterMs?: number;
  };
};

function makeCall(id = "call-1"): Tool.Call {
  return { id, tool: "bash", input: { command: "bun test" } };
}

function verdictPolicy(verdict: Policy.Verdict): PolicyRegistration {
  return {
    name: `test-${verdict.action}`,
    timing: "invoke.prepare",
    priority: 0,
    fn: async () => verdict,
  };
}

function engineWith(verdict: Policy.Verdict) {
  const engine = PolicyEngine.create();
  engine.register(verdictPolicy(verdict));
  return engine;
}

async function flushBus(): Promise<void> {
  await Promise.resolve();
}

describe("createToolExecutor invoke.prepare verdict handling", () => {
  it("blocks tool execution when policy returns deny", async () => {
    Bus.reset();
    let calls = 0;
    const denied: unknown[] = [];
    const started: unknown[] = [];
    Bus.subscribe(ToolExecution.PermissionDenied, (event) => denied.push(event));
    Bus.subscribe(ToolExecution.Started, (event) => started.push(event));

    const engine = engineWith({ action: "deny", reason: "sandbox_violation" });
    const executor = createToolExecutor({
      engine,
      traceContext: { traceId: "trace-deny", sessionId: "sess-deny" },
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-deny", toolCallId: call.id, output: "should not run" };
      },
    });

    const result = await executor(makeCall("call-deny"));
    await flushBus();

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("[Denied: sandbox_violation]");
    expect(started).toHaveLength(0);
    expect(denied).toHaveLength(1);
    expect((denied[0] as { reason: string; toolCallId: string }).reason).toBe("sandbox_violation");
  });

  it("fails closed when invoke.prepare returns inject", async () => {
    let calls = 0;
    const engine = engineWith({
      action: "inject",
      message: "not valid here",
      reason: "wrong_boundary",
    });
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-inject", toolCallId: call.id, output: "should not run" };
      },
    });

    const result = await executor(makeCall("call-inject"));

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("[Denied: inject verdict is not valid for invoke.prepare]");
  });

  it("blocks execution with retry-after metadata when policy returns retry", async () => {
    let calls = 0;
    const engine = engineWith({ action: "retry", reason: "rate_limited" });
    const executor = createToolExecutor({
      engine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-retry", toolCallId: call.id, output: "should not run" };
      },
    });

    const result: ResultWithMetadata = await executor(makeCall("call-retry"));

    expect(calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.output).toBe("[Retry requested: rate_limited]");
    expect(result.metadata).toEqual({
      verdict: "retry",
      reason: "rate_limited",
      retryAfterMs: 0,
    });
  });

  it("preserves skip and abort blocking behavior", async () => {
    let calls = 0;
    const skipEngine = engineWith({ action: "skip", reason: "optional" });
    const skipExecutor = createToolExecutor({
      engine: skipEngine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-skip", toolCallId: call.id, output: "should not run" };
      },
    });

    const skipResult = await skipExecutor(makeCall("call-skip"));
    expect(skipResult).toMatchObject({
      toolCallId: "call-skip",
      output: "[Skipped: optional]",
      isError: false,
    });

    const abortEngine = engineWith({ action: "abort", reason: "Blocked: hard stop" });
    const abortExecutor = createToolExecutor({
      engine: abortEngine,
      toolExecutor: async (call) => {
        calls += 1;
        return { id: "result-abort", toolCallId: call.id, output: "should not run" };
      },
    });

    const abortResult = await abortExecutor(makeCall("call-abort"));
    expect(abortResult).toMatchObject({
      toolCallId: "call-abort",
      output: "[Blocked: hard stop]",
      isError: true,
    });
    expect(calls).toBe(0);
  });
});
