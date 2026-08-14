import { describe, expect, it } from "bun:test";
import { Bus } from "@openomni/telemetry";
import { ToolExecution } from "@openomni/protocol";
import { PolicyEngine } from "../../../src/core/policy";
import { createToolExecutor } from "../../../src/core/execution/tool-executor";
import type { Tool } from "@openomni/protocol";
import type { PolicyRegistration } from "../../../src/core/policy/types";
import { abortRun } from "../../helpers/policy-decision";

function makeEngine() {
  return PolicyEngine.create();
}

function makeCall(id = "call-1", tool = "bash"): Tool.Call {
  return { id, tool, input: { command: "ls" } };
}

function abortMiddleware(reason: string): PolicyRegistration {
  return {
    kind: "point",
    name: "test-abort",
    pointIds: ["tool.native.pre"],
    effectCapabilities: { "tool.native.pre": ["run.abort"] },
    priority: 0,
    fn: async () => abortRun("test.abort", reason),
  };
}

async function flushBus(): Promise<void> {
  await Promise.resolve();
}

describe("createToolExecutor bus events", () => {
  // #522 defect 2: the worker-side executor beneath this wrapper is the sole
  // emitter of ToolExecution.Started/Completed. This layer delegates with
  // trace context and emits no execution events of its own; the composed
  // one-pair-per-call pin lives in tool-executor-sole-emitter.test.ts.
  it("emits no ToolExecution events and delegates with trace context", async () => {
    Bus.reset();
    const publishedNames: string[] = [];
    const stopObserve = Bus.observe((event) => {
      if (!event.name.startsWith("operational.")) {
        publishedNames.push(event.name);
      }
    });
    const delegatedContexts: unknown[] = [];

    const executor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      toolExecutor: async (call, context) => {
        delegatedContexts.push(context?.traceContext);
        return {
          id: "r1",
          toolCallId: call.id,
          output: "ok",
          isError: false,
        };
      },
      engine: makeEngine(),
    });

    await executor(makeCall());
    await flushBus();
    stopObserve();

    expect(publishedNames).toEqual([]);
    expect(delegatedContexts).toHaveLength(1);
    expect(delegatedContexts[0]).toMatchObject({ traceId: "trace-1", sessionId: "sess-1" });
  });

  it("emits no Completed itself when tool result has error", async () => {
    Bus.reset();
    const completed: unknown[] = [];
    Bus.subscribe(ToolExecution.Completed, (d) => completed.push(d));

    const executor = createToolExecutor({
      events: Bus,
      toolExecutor: async (call) => ({
        id: "r1",
        toolCallId: call.id,
        output: "err",
        isError: true,
      }),
      engine: makeEngine(),
      traceContext: { traceId: "trace-2", sessionId: "sess-2", runId: "run-1" },
    });

    const result = await executor(makeCall("call-err"));
    await flushBus();

    expect(result.isError).toBe(true);
    expect(completed).toHaveLength(0);
  });

  it("publishes PermissionDenied and no Started on abort", async () => {
    Bus.reset();
    const started: unknown[] = [];
    const denied: unknown[] = [];
    const publishedNames: string[] = [];
    const stopObserve = Bus.observe((event) => {
      if (!event.name.startsWith("operational.")) {
        publishedNames.push(event.name);
      }
    });
    Bus.subscribe(ToolExecution.Started, (d) => started.push(d));
    Bus.subscribe(ToolExecution.PermissionDenied, (d) => denied.push(d));

    const engine = makeEngine();
    engine.register(abortMiddleware("Blocked: test rule"));

    const executor = createToolExecutor({
      events: Bus,
      toolExecutor: async () => ({ id: "r1", toolCallId: "x", output: "never", isError: false }),
      engine,
      traceContext: { traceId: "trace-3", sessionId: "sess-3", runId: "run-1" },
    });

    const result = await executor(makeCall("call-deny"));
    await flushBus();
    stopObserve();

    expect(result.isError).toBe(true);
    expect(result.output).toBe("[Denied: Blocked: test rule]");
    expect(started).toHaveLength(0);
    expect(denied).toHaveLength(1);
    expect(publishedNames).toEqual(["tool.execution.permission_denied"]);
    expect(publishedNames).not.toContain("agent.tool.blocked");

    const d = denied[0] as { reason: string; toolName: string; toolCallId: string };
    expect(d.reason).toBe("Blocked: test rule");
    expect(d.toolName).toBe("bash");
    expect(d.toolCallId).toBe("call-deny");
  });

  it("rethrows and emits no ToolExecution events when toolExecutor throws", async () => {
    Bus.reset();
    const started: unknown[] = [];
    const completed: unknown[] = [];
    Bus.subscribe(ToolExecution.Started, (d) => started.push(d));
    Bus.subscribe(ToolExecution.Completed, (d) => completed.push(d));

    const executor = createToolExecutor({
      events: Bus,
      toolExecutor: async () => {
        throw new Error("boom");
      },
      engine: makeEngine(),
      traceContext: { traceId: "trace-4", sessionId: "sess-4", runId: "run-1" },
    });

    await expect(executor(makeCall("call-throw"))).rejects.toThrow("boom");
    await flushBus();

    expect(started).toHaveLength(0);
    expect(completed).toHaveLength(0);
  });

  it("reports tool duration for budget accounting on success and failure", async () => {
    const durations: number[] = [];
    const successExecutor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      toolExecutor: async (call) => ({
        id: "r1",
        toolCallId: call.id,
        output: "ok",
      }),
      engine: makeEngine(),
      onToolComplete: (durationMs) => durations.push(durationMs),
    });

    await successExecutor(makeCall("call-budget-ok"));

    const failureExecutor = createToolExecutor({
      events: Bus,
      traceContext: { traceId: "trace-1", sessionId: "sess-1", runId: "run-1" },
      toolExecutor: async () => {
        throw new Error("boom");
      },
      engine: makeEngine(),
      onToolComplete: (durationMs) => durations.push(durationMs),
    });

    await expect(failureExecutor(makeCall("call-budget-fail"))).rejects.toThrow("boom");

    expect(durations).toHaveLength(2);
    expect(durations.every((duration) => duration >= 0)).toBe(true);
  });

  it("refuses to build without the run trace context", () => {
    expect(() =>
      createToolExecutor({
        events: Bus,
        toolExecutor: async () => ({ id: "r", toolCallId: "c", output: "" }),
        engine: PolicyEngine.create(),
      }),
    ).toThrow("tool executor requires a trace context with");
  });

  it("publishes actor from trace context on PermissionDenied", async () => {
    Bus.reset();
    const denied: unknown[] = [];
    Bus.subscribe(ToolExecution.PermissionDenied, (d) => denied.push(d));

    const denyEngine = makeEngine();
    denyEngine.register(abortMiddleware("Blocked: actor rule"));
    const denyExecutor = createToolExecutor({
      events: Bus,
      toolExecutor: async () => ({ id: "r2", toolCallId: "x", output: "never", isError: false }),
      engine: denyEngine,
      traceContext: {
        traceId: "trace-6",
        sessionId: "sess-6",
        runId: "run-6",
        agentName: "reviewer",
      },
    });

    await denyExecutor(makeCall("call-denied-actor"));
    await flushBus();

    expect((denied[0] as { actor: Record<string, unknown> }).actor).toEqual({
      agentName: "reviewer",
    });
  });
});
