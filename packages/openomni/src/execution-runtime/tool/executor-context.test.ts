import { describe, expect, it } from "bun:test";
import type { Tool, TraceContext } from "@openomni/protocol";
import { createToolExecutor } from "./executor.js";
import type { NativeTool, ToolExecutionContext } from "./types.js";

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

  it("keeps the context-free execution path trace-free", async () => {
    let observedContext: ToolExecutionContext | undefined;
    const executor = createToolExecutor({
      tools: [makeTool((_call, context) => (observedContext = context))],
    });

    await executor({ id: "context-free-call", tool: "trace.probe", input: {} });

    expect(observedContext?.traceContext).toBeUndefined();
    expect(observedContext?.signal?.aborted).toBe(false);
  });
});
