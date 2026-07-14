/// <reference types="bun" />

import { describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { createToolExecutor } from "../../../src/core/execution/tool-executor";
import { PolicyEngine } from "../../../src/core/policy";

describe("createToolExecutor execution context", () => {
  it("forwards the active trace while preserving the per-call cancellation signal", async () => {
    const fallbackController = new AbortController();
    const callController = new AbortController();
    callController.abort("cancelled by caller");
    const traceContext = {
      traceId: "trace-tool-context",
      sessionId: "session-tool-context",
      runId: "run-tool-context",
    };
    let capturedContext: Tool.ExecutionContext | undefined;
    const executor = createToolExecutor({
      engine: PolicyEngine.create(),
      signal: fallbackController.signal,
      traceContext,
      toolExecutor: async (call, context) => {
        capturedContext = context;
        return { id: "result-tool-context", toolCallId: call.id, output: "ok" };
      },
    });

    await executor(
      { id: "call-tool-context", tool: "fixture", input: {} },
      { signal: callController.signal },
    );

    expect(capturedContext).toEqual({
      signal: callController.signal,
      traceContext,
    });
    expect(capturedContext?.traceContext).toBe(traceContext);
    expect(capturedContext?.signal?.aborted).toBe(true);
  });

  it("prefers the per-call trace while falling back to the configured cancellation signal", async () => {
    const fallbackController = new AbortController();
    fallbackController.abort("cancelled by run");
    const fallbackTrace = { traceId: "trace-fallback", sessionId: "session-fallback" };
    const callTrace = { traceId: "trace-call", sessionId: "session-call", runId: "run-call" };
    let capturedContext: Tool.ExecutionContext | undefined;
    const executor = createToolExecutor({
      engine: PolicyEngine.create(),
      signal: fallbackController.signal,
      traceContext: fallbackTrace,
      toolExecutor: async (call, context) => {
        capturedContext = context;
        return { id: "result-call-trace", toolCallId: call.id, output: "ok" };
      },
    });

    await executor(
      { id: "call-call-trace", tool: "fixture", input: {} },
      { traceContext: callTrace },
    );

    expect(capturedContext).toEqual({
      signal: fallbackController.signal,
      traceContext: callTrace,
    });
    expect(capturedContext?.traceContext).toBe(callTrace);
    expect(capturedContext?.signal?.aborted).toBe(true);
  });
});
