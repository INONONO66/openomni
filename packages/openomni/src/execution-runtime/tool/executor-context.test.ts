import { describe, expect, it } from "bun:test";
import type { Tool, TraceContext } from "@openomni/protocol";
import { createToolExecutor } from "./executor.js";
import type { NativeTool, ToolExecutionContext } from "./types.js";
import { Bus } from "@openomni/telemetry";

function makeTool(
  observe: (call: Tool.Call, context: ToolExecutionContext | undefined) => void,
): NativeTool {
  return {
    spec: { name: "trace.probe", inputSchema: {} },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    async execute(call, context) {
      observe(call, context);
      return { id: "trace-result", toolCallId: call.id, output: "ok" };
    },
  };
}

describe("OpenOmni tool executor context", () => {
  /**
   * The defect this guard replaced was not a missing throw: `createEventBase`
   * minted a traceId per event, so one tool call published four events under
   * four traces that did not correlate with each other, let alone with the
   * run. Pinning only the refusal would leave that free to come back.
   */
  it("files every event of one call under the calling run's trace", async () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const seen: Array<{ name: string; traceId: unknown }> = [];
    const unsubscribe = Bus.observe((descriptor, payload) => {
      seen.push({ name: descriptor.name, traceId: (payload as { traceId?: unknown }).traceId });
    });
    const executor = createToolExecutor({ tools: [makeTool(() => undefined)] });

    try {
      await executor(
        { id: "one-call", tool: "trace.probe", input: {} },
        { traceContext: { traceId, sessionId: "session-1", runId: "run-1" } },
      );
      await Bun.sleep(0);
    } finally {
      unsubscribe();
    }

    expect(seen.length).toBeGreaterThan(1);
    expect([...new Set(seen.map((event) => event.traceId))]).toEqual([traceId]);
  });
  it("preserves trusted trace context while replacing the caller signal", async () => {
    let observedCall: Tool.Call | undefined;
    let observedContext: ToolExecutionContext | undefined;
    const callerController = new AbortController();
    const traceContext: TraceContext.Type = {
      traceId: "trusted-trace",
      sessionId: "trusted-session",
      runId: "trusted-run",
      agentName: "trusted-agent",
    };
    const executor = createToolExecutor({
      tools: [
        makeTool((call, context) => {
          observedCall = call;
          observedContext = context;
        }),
      ],
    });

    await executor(
      {
        id: "trace-call",
        tool: "trace.probe",
        input: { sessionId: "spoofed-session", runId: "spoofed-run" },
      },
      { signal: callerController.signal, traceContext },
    );

    expect(observedCall?.input).toEqual({
      sessionId: "spoofed-session",
      runId: "spoofed-run",
    });
    expect(observedContext?.traceContext).toBe(traceContext);
    expect(observedContext?.signal).not.toBe(callerController.signal);
    expect(observedContext?.signal?.aborted).toBe(false);
  });

  /**
   * A tool call exists because a run asked for it, so it is never a trace
   * origin. A context-free call used to run and publish four events under four
   * freshly minted trace ids; it is now refused before the tool is reached.
   */
  it("refuses a call that arrives without the run trace", async () => {
    let invoked = false;
    const executor = createToolExecutor({
      tools: [
        makeTool(() => {
          invoked = true;
        }),
      ],
    });

    await expect(
      executor({ id: "context-free-call", tool: "trace.probe", input: {} }),
    ).rejects.toThrow("tool execution requires the run trace context");
    expect(invoked).toBe(false);
  });
});
