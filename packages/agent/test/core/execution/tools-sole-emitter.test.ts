import { describe, expect, it } from "bun:test";
import { Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createToolExecutor } from "../../../src/core/execution/tools";
import { PolicyEngine } from "../../../src/core/policy";

// #522 defect 2 — sole-emitter pin. The worker-side executor
// The injected product executor is the SOLE
// emitter of Tool.Events.Started/Completed. The agent-side wrapper keeps
// policy dispatch and effect application only; it must not re-emit. This
// composes the agent wrapper over a base executor that emits the worker
// executor's event pair and pins exactly ONE Started and ONE Completed per
// native tool call.

function makeCall(id = "call-1", tool = "bash"): Tool.Call {
  return { id, tool, input: { command: "ls" } };
}

/** Emits the Tool.Events event pair exactly as the worker executor does. */
function emittingBaseExecutor(result: {
  output: string;
  isError?: boolean;
  throws?: Error;
}): (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result> {
  return async (call, context) => {
    const base = {
      traceId: context?.traceContext?.traceId ?? crypto.randomUUID(),
      sessionId: context?.traceContext?.sessionId ?? "",
      time: Date.now(),
      actor: { kind: "agent" },
    };
    Bus.publish(Tool.Events.Started, {
      ...base,
      toolCallId: call.id,
      toolName: call.tool,
    });
    Bus.publish(Tool.Events.Completed, {
      ...base,
      toolCallId: call.id,
      toolName: call.tool,
      durationMs: 0,
      isError: result.throws !== undefined || (result.isError ?? false),
    });
    if (result.throws) throw result.throws;
    return {
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: result.output,
      ...(result.isError !== undefined && { isError: result.isError }),
    };
  };
}

describe("sole emitter — worker executor owns Tool.Events events", () => {
  it("one native tool call emits exactly one Started and one Completed", async () => {
    Bus.reset();
    const started: unknown[] = [];
    const completed: unknown[] = [];
    Bus.subscribe(Tool.Events.Started, (d) => started.push(d));
    Bus.subscribe(Tool.Events.Completed, (d) => completed.push(d));

    const executor = createToolExecutor({
      events: Bus,
      toolExecutor: emittingBaseExecutor({ output: "ok" }),
      engine: PolicyEngine.create(),
      traceContext: { traceId: "trace-sole", sessionId: "sess-sole", runId: "run-1" },
    });

    await executor(makeCall("call-sole"));
    await Promise.resolve();

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
  });

  it("one erroring tool call emits exactly one Completed (isError)", async () => {
    Bus.reset();
    const completed: unknown[] = [];
    Bus.subscribe(Tool.Events.Completed, (d) => completed.push(d));

    const executor = createToolExecutor({
      events: Bus,
      toolExecutor: emittingBaseExecutor({ output: "err", isError: true }),
      engine: PolicyEngine.create(),
      traceContext: { traceId: "trace-sole-err", sessionId: "sess-sole-err", runId: "run-1" },
    });

    await executor(makeCall("call-sole-err"));
    await Promise.resolve();

    expect(completed).toHaveLength(1);
    expect((completed[0] as { isError: boolean }).isError).toBe(true);
  });

  it("a throwing execution emits exactly one Completed", async () => {
    Bus.reset();
    const completed: unknown[] = [];
    Bus.subscribe(Tool.Events.Completed, (d) => completed.push(d));

    const executor = createToolExecutor({
      events: Bus,
      toolExecutor: emittingBaseExecutor({ output: "boom", throws: new Error("boom") }),
      engine: PolicyEngine.create(),
      traceContext: { traceId: "trace-sole-throw", sessionId: "sess-sole-throw", runId: "run-1" },
    });

    await expect(executor(makeCall("call-sole-throw"))).rejects.toThrow("boom");
    await Promise.resolve();

    expect(completed).toHaveLength(1);
  });
});
