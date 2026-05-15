import { describe, expect, it } from "bun:test";
import { Bus } from "@openomni/session";
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
    name: "test-abort",
    timing: "invoke.prepare",
    priority: 0,
    fn: async () => abortRun("test.abort", reason),
  };
}

async function flushBus(): Promise<void> {
  await Promise.resolve();
}

describe("createToolExecutor bus events", () => {
  it("publishes Started then Completed on successful execution", async () => {
    Bus.reset();
    const started: unknown[] = [];
    const completed: unknown[] = [];
    const publishedNames: string[] = [];
    const stopObserve = Bus.observe((event) => {
      if (!event.name.startsWith("operational.")) {
        publishedNames.push(event.name);
      }
    });
    Bus.subscribe(ToolExecution.Started, (d) => started.push(d));
    Bus.subscribe(ToolExecution.Completed, (d) => completed.push(d));

    const executor = createToolExecutor({
      toolExecutor: async (call) => ({
        id: "r1",
        toolCallId: call.id,
        output: "ok",
        isError: false,
      }),
      engine: makeEngine(),
      traceContext: { traceId: "trace-1", sessionId: "sess-1" },
    });

    await executor(makeCall());
    await flushBus();
    stopObserve();

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(publishedNames).toEqual(["tool.execution.started", "tool.execution.completed"]);
    expect(publishedNames).not.toContain("agent.tool.invoked");

    const s = started[0] as {
      traceId: string;
      sessionId: string;
      toolName: string;
      toolCallId: string;
      inputSummary: string;
    };
    expect(s.traceId).toBe("trace-1");
    expect(s.sessionId).toBe("sess-1");
    expect(s.toolName).toBe("bash");
    expect(s.toolCallId).toBe("call-1");
    expect(s.inputSummary).toBe('{"command":"ls"}');

    const c = completed[0] as { isError: boolean; durationMs: number };
    expect(c.isError).toBe(false);
    expect(typeof c.durationMs).toBe("number");
  });

  it("publishes Completed with isError:true when tool result has error", async () => {
    Bus.reset();
    const completed: unknown[] = [];
    Bus.subscribe(ToolExecution.Completed, (d) => completed.push(d));

    const executor = createToolExecutor({
      toolExecutor: async (call) => ({
        id: "r1",
        toolCallId: call.id,
        output: "err",
        isError: true,
      }),
      engine: makeEngine(),
      traceContext: { traceId: "trace-2", sessionId: "sess-2" },
    });

    await executor(makeCall("call-err"));
    await flushBus();

    expect(completed).toHaveLength(1);
    expect((completed[0] as { isError: boolean }).isError).toBe(true);
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
      toolExecutor: async () => ({ id: "r1", toolCallId: "x", output: "never", isError: false }),
      engine,
      traceContext: { traceId: "trace-3", sessionId: "sess-3" },
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

  it("publishes Completed with isError:true when toolExecutor throws", async () => {
    Bus.reset();
    const started: unknown[] = [];
    const completed: unknown[] = [];
    Bus.subscribe(ToolExecution.Started, (d) => started.push(d));
    Bus.subscribe(ToolExecution.Completed, (d) => completed.push(d));

    const executor = createToolExecutor({
      toolExecutor: async () => {
        throw new Error("boom");
      },
      engine: makeEngine(),
      traceContext: { traceId: "trace-4", sessionId: "sess-4" },
    });

    await expect(executor(makeCall("call-throw"))).rejects.toThrow("boom");
    await flushBus();

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect((completed[0] as { isError: boolean }).isError).toBe(true);
  });

  it("reports tool duration for budget accounting on success and failure", async () => {
    const durations: number[] = [];
    const successExecutor = createToolExecutor({
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

  it("falls back to generated traceId when no traceContext provided", async () => {
    Bus.reset();
    const started: unknown[] = [];
    Bus.subscribe(ToolExecution.Started, (d) => started.push(d));

    const executor = createToolExecutor({
      toolExecutor: async (call) => ({
        id: "r1",
        toolCallId: call.id,
        output: "ok",
        isError: false,
      }),
      engine: makeEngine(),
    });

    await executor(makeCall());
    await flushBus();

    expect(started).toHaveLength(1);
    const s = started[0] as { traceId: string; sessionId: string };
    expect(s.traceId.length).toBeGreaterThan(0);
    expect(s.sessionId).toBe("");
  });

  it("publishes actor from trace context", async () => {
    Bus.reset();
    const started: unknown[] = [];
    const denied: unknown[] = [];
    Bus.subscribe(ToolExecution.Started, (d) => started.push(d));
    Bus.subscribe(ToolExecution.PermissionDenied, (d) => denied.push(d));

    const allowExecutor = createToolExecutor({
      toolExecutor: async (call) => ({
        id: "r1",
        toolCallId: call.id,
        output: "ok",
        isError: false,
      }),
      engine: makeEngine(),
      traceContext: { traceId: "trace-5", sessionId: "sess-5", agentName: "coder" },
    });

    await allowExecutor(makeCall("call-actor"));

    const denyEngine = makeEngine();
    denyEngine.register(abortMiddleware("Blocked: actor rule"));
    const denyExecutor = createToolExecutor({
      toolExecutor: async () => ({ id: "r2", toolCallId: "x", output: "never", isError: false }),
      engine: denyEngine,
      traceContext: { traceId: "trace-6", sessionId: "sess-6", agentName: "reviewer" },
    });

    await denyExecutor(makeCall("call-denied-actor"));
    await flushBus();

    expect((started[0] as { actor: Record<string, unknown> }).actor).toEqual({
      agentName: "coder",
    });
    expect((denied[0] as { actor: Record<string, unknown> }).actor).toEqual({
      agentName: "reviewer",
    });
  });
});
