import { describe, expect, it } from "bun:test";
import { PolicyDecision, type Tool } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createToolExecutor } from "./executor.js";
import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";
import type { NativeTool, ToolRiskTier } from "./types.js";

/**
 * The trace the real caller attaches to every tool call. The executor and the
 * runtime policy both inherit it rather than mint one, so a test that omits it
 * is exercising a path production does not have.
 */
const RUN_TRACE = {
  traceContext: { traceId: "trace-executor-test", sessionId: "session-1", runId: "run-1" },
} as const;

function makeCall(tool: string, input: Record<string, unknown> = {}): Tool.Call {
  return { id: "call-1", tool, input };
}

function makeTool(
  name: string,
  overrides: Partial<NativeTool> & { riskTier?: ToolRiskTier } = {},
): NativeTool {
  const { riskTier = 0, ...rest } = overrides;
  return {
    spec: { name, inputSchema: { type: "object", properties: {} } },
    riskTier,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    execute: async (call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: `${name}-ok`,
    }),
    ...rest,
  };
}

function collectBusEvents(): {
  events: Array<{ name: string; payload: Record<string, unknown> }>;
  stop: () => void;
} {
  const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const unsubscribe = Bus.observe((descriptor, payload) => {
    // Filter out operational.* events from Log→Bus migration
    if (!descriptor.name.startsWith("operational.")) {
      events.push({ name: descriptor.name, payload: payload as Record<string, unknown> });
    }
  });
  return { events, stop: unsubscribe };
}

describe("createToolExecutor", () => {
  it("dispatches to the correct tool and returns its result", async () => {
    const executor = createToolExecutor({
      tools: [
        makeTool("read", {
          execute: async (call) => ({ id: "r1", toolCallId: call.id, output: "file-content" }),
        }),
      ],
    });

    const result = await executor(makeCall("read"), RUN_TRACE);

    expect(result.output).toBe("file-content");
    expect(result.isError).toBeUndefined();
    expect(result.toolCallId).toBe("call-1");
  });

  it("returns an error result for unknown tools", async () => {
    const executor = createToolExecutor({ tools: [] });

    const result = await executor(makeCall("nonexistent"), RUN_TRACE);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool: nonexistent");
  });

  it("does not enforce authority permissions inside the native executor", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash")],
      config: { permissions: { action: "tool.call", denylist: ["bash"] } },
    });

    const result = await executor(makeCall("bash"), RUN_TRACE);

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("bash-ok");
  });

  it("leaves allowlist decisions to the agent policy layer", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("write"), makeTool("read")],
      config: { permissions: { action: "tool.call", allowlist: ["read"] } },
    });

    const writeResult = await executor(makeCall("write"), RUN_TRACE);
    expect(writeResult.isError).toBeUndefined();
    expect(writeResult.output).toBe("write-ok");

    const readResult = await executor(makeCall("read"), RUN_TRACE);
    expect(readResult.isError).toBeUndefined();
  });

  it("leaves approval decisions to the agent policy layer", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash")],
      config: { permissions: { action: "tool.call", requireApproval: ["bash"] } },
    });

    const result = await executor(makeCall("bash"), RUN_TRACE);

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("bash-ok");
  });

  it("wraps tool execution errors in an error result", async () => {
    const executor = createToolExecutor({
      tools: [
        makeTool("fail", {
          execute: async () => {
            throw new Error("boom");
          },
        }),
      ],
    });

    const result = await executor(makeCall("fail"), RUN_TRACE);

    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");
  });

  it("wraps tool timeouts in the legacy error result shape", async () => {
    const executor = createToolExecutor({
      tools: [
        makeTool("slow", {
          execute: () =>
            new Promise<Tool.Result>(() => {
              // intentional: never resolves to test timeout
            }),
        }),
      ],
      config: { timeoutMs: { tier0: 10 } },
    });

    const result = await executor(makeCall("slow"), RUN_TRACE);

    expect(result.toolCallId).toBe("call-1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("timeout after 10ms");
  });

  it("does not invoke tools when execution context is already aborted", async () => {
    let invoked = false;
    const executor = createToolExecutor({
      tools: [
        makeTool("read", {
          execute: async (call) => {
            invoked = true;
            return { id: "r1", toolCallId: call.id, output: "unexpected" };
          },
        }),
      ],
    });
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    const result = await executor(makeCall("read"), { ...RUN_TRACE, signal: controller.signal });

    expect(invoked).toBe(false);
    expect(result.toolCallId).toBe("call-1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Tool execution aborted");
  });

  it("keeps timeout authoritative when cooperative abort rejects immediately", async () => {
    let receivedSignal: AbortSignal | undefined;
    const { events, stop } = collectBusEvents();
    const executor = createToolExecutor({
      tools: [
        makeTool("slow", {
          execute: (_call, context) => {
            const signal = context?.signal;
            receivedSignal = signal;
            return new Promise<Tool.Result>((_, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  const error = new Error("cooperative abort");
                  error.name = "AbortError";
                  reject(error);
                },
                { once: true },
              );
            });
          },
        }),
      ],
      config: { timeoutMs: { tier0: 10 } },
    });

    try {
      const result = await executor(makeCall("slow"), RUN_TRACE);

      expect(receivedSignal?.aborted).toBe(true);
      expect(result.toolCallId).toBe("call-1");
      expect(result.isError).toBe(true);
      expect(result.output).toBe("timeout after 10ms");
      expect(events.some((event) => event.name === "tool.execution.timed_out")).toBe(true);
    } finally {
      stop();
    }
  });

  it("aborts cooperative native tools when executor timeout fires", async () => {
    let receivedSignal: AbortSignal | undefined;
    let abortReason: unknown;
    const executor = createToolExecutor({
      tools: [
        makeTool("slow", {
          execute: async (_call, context) => {
            const signal = context?.signal;
            receivedSignal = signal;
            return await new Promise<Tool.Result>((_, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  abortReason = (signal as AbortSignal & { reason?: unknown }).reason;
                  const error = new Error("cooperative abort");
                  error.name = "AbortError";
                  reject(error);
                },
                { once: true },
              );
            });
          },
        }),
      ],
      config: { timeoutMs: { tier0: 10 } },
    });

    const result = await executor(makeCall("slow"), RUN_TRACE);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(abortReason).toBeInstanceOf(ToolRuntimePolicyMiddleware.TimeoutError);
    expect(result.toolCallId).toBe("call-1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("timeout after 10ms");
  });

  it("returns abort promptly when the parent signal aborts before timeout", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const executor = createToolExecutor({
      tools: [
        makeTool("slow", {
          execute: (_call, context) => {
            receivedSignal = context?.signal;
            return new Promise<Tool.Result>(() => {
              // intentional: non-cooperative tool ignores abort
            });
          },
        }),
      ],
      config: { timeoutMs: { tier0: 1_000 }, postTimeoutSettleGraceMs: 10 },
    });

    const resultPromise = executor(makeCall("slow"), { ...RUN_TRACE, signal: controller.signal });
    await Bun.sleep(0);
    controller.abort();
    const result = await resultPromise;

    expect(receivedSignal?.aborted).toBe(true);
    expect(result.toolCallId).toBe("call-1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Tool execution aborted");
  });

  it("dispatches to a dotted-name tool via its underscore alias", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("grep.search")],
    });

    const result = await executor(makeCall("grep_search"), RUN_TRACE);

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("grep.search-ok");
  });

  it("ignores authority wildcard policies in the native executor", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("file.read"), makeTool("file.write"), makeTool("bash")],
      config: { permissions: { action: "tool.call", denylist: ["file.*"] } },
    });

    const readResult = await executor(makeCall("file.read"), RUN_TRACE);
    expect(readResult.isError).toBeUndefined();

    const writeResult = await executor(makeCall("file.write"), RUN_TRACE);
    expect(writeResult.isError).toBeUndefined();

    const bashResult = await executor(makeCall("bash"), RUN_TRACE);
    expect(bashResult.isError).toBeUndefined();
  });

  it("does not apply canonical star wildcard authority patterns", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("read"), makeTool("bash")],
      config: { permissions: { action: "tool.call", denylist: ["*"] } },
    });

    const readResult = await executor(makeCall("read"), RUN_TRACE);
    expect(readResult.isError).toBeUndefined();

    const bashResult = await executor(makeCall("bash"), RUN_TRACE);
    expect(bashResult.isError).toBeUndefined();
  });

  it("does not apply guardrail input rule authority decisions", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash")],
      config: {
        permissions: {
          action: "tool.call",
          inputRules: [
            {
              toolPattern: "bash",
              field: "command",
              pattern: "rm -rf",
              action: "deny",
              reason: "dangerous_command",
              priority: 0,
            },
          ],
        },
      },
    });

    const result = await executor(makeCall("bash", { command: "rm -rf /tmp/example" }), RUN_TRACE);

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("bash-ok");
  });

  it("no permissions config allows all tools", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash"), makeTool("read")],
    });

    expect((await executor(makeCall("bash"), RUN_TRACE)).isError).toBeUndefined();
    expect((await executor(makeCall("read"), RUN_TRACE)).isError).toBeUndefined();
  });

  it("resolves risk-tier runtime policy with decision metadata", async () => {
    const decisions: string[] = [];

    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      traceContext: { traceId: "trace-executor-test", sessionId: "session-1", runId: "run-1" },
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
      riskTier: 2,
      timeoutConfig: { tier2: 15 },
      lockOwnerId: "owner-1",
      onDecision: (decision) => {
        decisions.push(`${decision.policyId}:${PolicyDecision.reason(decision, "")}`);
      },
    });

    expect(result.decision.verdict).toBe("allow");
    expect(result.decision.policyId).toBe("tool.runtime-policy");
    expect(PolicyDecision.reason(result.decision)).toBe("runtime policy evaluated");
    expect(result.handle.timeoutMs).toBe(15);
    expect(decisions).toContain("tool.runtime-policy:high-risk tool execution recorded");
    expect(decisions).toContain("tool.runtime-policy:timeout resolved");
    expect(decisions).toContain("tool.runtime-policy:workspace lock not required");
  });

  it("injects implicit inputs from runtime context", async () => {
    let capturedInput: Record<string, unknown> = {};
    const tool = makeTool("todo_write", {
      implicitInputs: { sessionId: "sessionId" },
      execute: async (call) => {
        capturedInput = call.input as Record<string, unknown>;
        return { id: "r1", toolCallId: call.id, output: "ok" };
      },
    });

    const executor = createToolExecutor({
      tools: [tool],
      config: {
        runtime: {
          sessionId: "ses-abc",
          runId: "run-1",
        },
      },
    });

    await executor(makeCall("todo_write", { todos: [] }), RUN_TRACE);
    expect(capturedInput.sessionId).toBe("ses-abc");
    expect(capturedInput.todos).toEqual([]);
  });

  it("does not inject when runtime context is absent", async () => {
    let capturedInput: Record<string, unknown> = {};
    const tool = makeTool("todo_write", {
      implicitInputs: { sessionId: "sessionId" },
      execute: async (call) => {
        capturedInput = call.input as Record<string, unknown>;
        return { id: "r1", toolCallId: call.id, output: "ok" };
      },
    });

    const executor = createToolExecutor({ tools: [tool] });
    await executor(makeCall("todo_write", { todos: [] }), RUN_TRACE);
    expect(capturedInput.sessionId).toBeUndefined();
  });

  it("strips a model-supplied value from an implicit slot when runtime is absent", async () => {
    let capturedInput: Record<string, unknown> = {};
    const tool = makeTool("todo_write", {
      implicitInputs: { sessionId: "sessionId" },
      execute: async (call) => {
        capturedInput = call.input as Record<string, unknown>;
        return { id: "r1", toolCallId: call.id, output: "ok" };
      },
    });

    // Implicit slots are executor-owned: without runtime the field must be
    // ABSENT, not whatever the model wrote — a session-scoped tool reading a
    // forged sessionId here would cross a read boundary (PR #719 review M2).
    const executor = createToolExecutor({ tools: [tool] });
    await executor(makeCall("todo_write", { todos: [], sessionId: "forged-session" }), RUN_TRACE);
    expect(capturedInput.sessionId).toBeUndefined();
    expect(capturedInput.todos).toEqual([]);
  });

  it("runtime injection overrides LLM-provided value", async () => {
    let capturedInput: Record<string, unknown> = {};
    const tool = makeTool("todo_write", {
      implicitInputs: { sessionId: "sessionId" },
      execute: async (call) => {
        capturedInput = call.input as Record<string, unknown>;
        return { id: "r1", toolCallId: call.id, output: "ok" };
      },
    });

    const executor = createToolExecutor({
      tools: [tool],
      config: {
        runtime: { sessionId: "real-session", runId: "run-1" },
      },
    });

    // LLM provides a wrong/stale sessionId — runtime should override
    await executor(makeCall("todo_write", { sessionId: "fake-session", todos: [] }), RUN_TRACE);
    expect(capturedInput.sessionId).toBe("real-session");
  });

  it("publishes policy and tool execution events in order", async () => {
    const { events, stop } = collectBusEvents();

    try {
      const executor = createToolExecutor({
        tools: [
          makeTool("write", {
            riskTier: 1,
            execute: async (call) => {
              return { id: "result-1", toolCallId: call.id, output: "written" };
            },
          }),
        ],
        config: {
          runtime: { sessionId: "ses-test", runId: "run-bus-success", agentName: "worker" },
        },
      });

      const result = await executor(makeCall("write", { path: "file.txt" }), RUN_TRACE);
      const eventNames = events.map((e) => e.name);

      expect(result.output).toBe("written");
      expect(eventNames).toEqual([
        "policy.action.requested",
        "tool.execution.started",
        "tool.execution.completed",
      ]);
      expect(events[0]?.payload).toMatchObject({
        action: "tool.call",
        resource: "write",
      });
      expect(events[1]?.payload).toMatchObject({
        toolCallId: "call-1",
        toolName: "write",
      });
      expect(events[2]?.payload).toMatchObject({
        toolCallId: "call-1",
        toolName: "write",
        isError: false,
      });
    } finally {
      stop();
    }
  });

  it("does not publish permission denial events from the native executor", async () => {
    const { events, stop } = collectBusEvents();
    let executions = 0;

    try {
      const executor = createToolExecutor({
        tools: [
          makeTool("bash", {
            riskTier: 1,
            execute: async (call) => {
              executions += 1;
              return { id: "result-1", toolCallId: call.id, output: "ran" };
            },
          }),
        ],
        config: {
          permissions: { action: "tool.call", denylist: ["bash"] },
          runtime: { sessionId: "ses-test", runId: "run-denied" },
        },
      });

      const result = await executor(makeCall("bash"), RUN_TRACE);
      const eventNames = events.map((e) => e.name);

      expect(result.isError).toBeUndefined();
      expect(executions).toBe(1);
      expect(eventNames).toEqual([
        "policy.action.requested",
        "tool.execution.started",
        "tool.execution.completed",
      ]);
      expect(events.some((e) => e.name === "policy.action.blocked")).toBe(false);
    } finally {
      stop();
    }
  });

  it("publishes action_blocked with timeout reason when timeout fires", async () => {
    const { events, stop } = collectBusEvents();

    try {
      const executor = createToolExecutor({
        tools: [
          makeTool("slow", {
            execute: () =>
              new Promise<Tool.Result>(() => {
                // intentional: never resolves to test timeout
              }),
          }),
        ],
        config: {
          timeoutMs: { tier0: 10 },
          runtime: { sessionId: "ses-test", runId: "run-timeout" },
        },
      });

      const result = await executor(makeCall("slow"), RUN_TRACE);

      expect(result.isError).toBe(true);
      const blocked = events.find((e) => e.name === "policy.action.blocked");
      const completed = events.find((e) => e.name === "tool.execution.completed");
      const timedOut = events.find((e) => e.name === "tool.execution.timed_out");

      expect(timedOut).toBeDefined();
      expect(blocked?.payload).toMatchObject({
        reason: "timeout after 10ms",
        resource: "slow",
      });
      expect(completed?.payload).toMatchObject({
        toolCallId: "call-1",
        toolName: "slow",
        isError: true,
      });
    } finally {
      stop();
    }
  });

  it("emits Tool.Events.TimedOut event when timeout fires", async () => {
    const publishedEvents: Array<{ name: string; payload: unknown }> = [];
    const unsubscribe = Bus.observe((descriptor, payload) => {
      publishedEvents.push({ name: descriptor.name, payload });
    });

    try {
      const executor = createToolExecutor({
        tools: [
          makeTool("slow", {
            execute: () =>
              new Promise<Tool.Result>(() => {
                // intentional: never resolves to test timeout
              }),
          }),
        ],
        config: {
          timeoutMs: { tier0: 10 },
          runtime: { sessionId: "ses-test", runId: "run-test" },
        },
      });

      const result = await executor(makeCall("slow"), RUN_TRACE);

      expect(result.isError).toBe(true);
      expect(result.output).toBe("timeout after 10ms");

      const timedOutEvent = publishedEvents.find((e) => e.name === "tool.execution.timed_out");
      expect(timedOutEvent).toBeDefined();
      expect(timedOutEvent?.payload).toMatchObject({
        toolCallId: "call-1",
        toolName: "slow",
        timeoutMs: 10,
        sessionId: "ses-test",
        runId: "run-test",
      });
    } finally {
      unsubscribe();
    }
  });

  it("does not emit Tool.Events.TimedOut for a tool that throws timeout-like error message", async () => {
    const publishedEvents: Array<{ name: string; payload: unknown }> = [];
    const unsubscribe = Bus.observe((descriptor, payload) => {
      publishedEvents.push({ name: descriptor.name, payload });
    });

    try {
      const executor = createToolExecutor({
        tools: [
          makeTool("fake_timeout", {
            execute: async () => {
              throw new Error("timeout after 10ms");
            },
          }),
        ],
        config: {
          runtime: { sessionId: "ses-test", runId: "run-test" },
        },
      });

      const result = await executor(makeCall("fake_timeout"), RUN_TRACE);

      expect(result.isError).toBe(true);
      expect(result.output).toBe("timeout after 10ms");

      const timedOutEvent = publishedEvents.find((e) => e.name === "tool.execution.timed_out");
      expect(timedOutEvent).toBeUndefined();
    } finally {
      unsubscribe();
    }
  });
});
