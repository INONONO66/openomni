import { describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { createToolExecutor } from "./executor.js";
import { createWorkspaceIdentity } from "../workspace-identity.js";
import type { NativeTool, ToolEffectIntentV1 } from "./types.js";

function makeCall(tool: string, input: Record<string, unknown> = {}): Tool.Call {
  return { id: "call-1", tool, input };
}

function makeReadTool(overrides: Partial<NativeTool> = {}): NativeTool {
  return {
    spec: { name: "read", inputSchema: { type: "object", properties: {} } },
    riskTier: 0,
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    source: "system",
    execute: async (call) => ({
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output: "read-ok",
    }),
    ...overrides,
  };
}

describe("createToolExecutor", () => {
  it("dispatches to a statically read-only tool", async () => {
    const executor = createToolExecutor({
      tools: [
        makeReadTool({
          execute: async (call) => ({ id: "r1", toolCallId: call.id, output: "file-content" }),
        }),
      ],
    });

    const result = await executor(makeCall("read"));

    expect(result.output).toBe("file-content");
    expect(result.isError).toBeUndefined();
    expect(result.toolCallId).toBe("call-1");
  });

  it("returns an error result for unknown tools", async () => {
    const executor = createToolExecutor({ tools: [] });

    const result = await executor(makeCall("nonexistent"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Unknown tool: nonexistent");
  });

  it("wraps tool execution errors in an error result", async () => {
    const executor = createToolExecutor({
      tools: [
        makeReadTool({
          execute: async () => {
            throw new Error("boom");
          },
        }),
      ],
    });

    const result = await executor(makeCall("read"));

    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");
  });

  it("returns the timeout error shape for a non-cooperative read", async () => {
    const executor = createToolExecutor({
      tools: [
        makeReadTool({
          execute: () => new Promise<Tool.Result>(() => undefined),
        }),
      ],
      config: { timeoutMs: { tier0: 10 } },
    });

    const result = await executor(makeCall("read"));

    expect(result.toolCallId).toBe("call-1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("timeout after 10ms");
  });

  it("does not invoke a read when execution context is already aborted", async () => {
    let invoked = false;
    const executor = createToolExecutor({
      tools: [
        makeReadTool({
          execute: async (call) => {
            invoked = true;
            return { id: "r1", toolCallId: call.id, output: "unexpected" };
          },
        }),
      ],
    });
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    const result = await executor(makeCall("read"), { signal: controller.signal });

    expect(invoked).toBe(false);
    expect(result.toolCallId).toBe("call-1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Tool execution aborted");
  });

  it("returns abort promptly when the parent signal aborts", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const executor = createToolExecutor({
      tools: [
        makeReadTool({
          execute: (_call, context) => {
            receivedSignal = context?.signal;
            return new Promise<Tool.Result>(() => undefined);
          },
        }),
      ],
      config: { timeoutMs: { tier0: 1_000 } },
    });

    const resultPromise = executor(makeCall("read"), { signal: controller.signal });
    await Bun.sleep(0);
    controller.abort();
    const result = await resultPromise;

    expect(receivedSignal?.aborted).toBe(true);
    expect(result.toolCallId).toBe("call-1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Tool execution aborted");
  });

  it("injects runtime-owned implicit inputs", async () => {
    let capturedInput: Record<string, unknown> = {};
    const executor = createToolExecutor({
      tools: [
        makeReadTool({
          implicitInputs: { sessionId: "sessionId" },
          execute: async (call) => {
            capturedInput = call.input as Record<string, unknown>;
            return { id: "r1", toolCallId: call.id, output: "ok" };
          },
        }),
      ],
      config: { runtime: { sessionId: "real-session", runId: "run-1" } },
    });

    await executor(makeCall("read", { sessionId: "untrusted-session" }));

    expect(capturedInput.sessionId).toBe("real-session");
  });

  it("emits a timeout event only for executor timeouts", async () => {
    const publishedEvents: Array<{ name: string; payload: unknown }> = [];
    const unsubscribe = Bus.observe((descriptor, payload) => {
      publishedEvents.push({ name: descriptor.name, payload });
    });

    try {
      const executor = createToolExecutor({
        tools: [
          makeReadTool({
            execute: () => new Promise<Tool.Result>(() => undefined),
          }),
        ],
        config: {
          timeoutMs: { tier0: 10 },
          runtime: { sessionId: "ses-test", runId: "run-test" },
        },
      });

      const result = await executor(makeCall("read"));
      expect(result.isError).toBe(true);

      const timedOutEvent = publishedEvents.find(
        (event) => event.name === "tool.execution.timed_out",
      );
      expect(timedOutEvent?.payload).toMatchObject({
        toolCallId: "call-1",
        toolName: "read",
        timeoutMs: 10,
        sessionId: "ses-test",
        runId: "run-test",
      });
    } finally {
      unsubscribe();
    }
  });
});

describe("tool effect intents", () => {
  it("records the exact scoped execution intent before a mutating act and settles failure", async () => {
    const order: string[] = [];
    let captured: ToolEffectIntentV1 | undefined;
    const tool: NativeTool = {
      ...makeReadTool(),
      spec: { name: "write", inputSchema: { type: "object", properties: {} } },
      isReadOnly: false,
      execute: async (call) => {
        order.push("act");
        return { id: "failed", toolCallId: call.id, output: "denied", isError: true };
      },
    };
    const executor = createToolExecutor({
      tools: [tool],
      config: {
        runtime: { sessionId: "session-1", runId: "attempt-1" },
        workspaceIdentity: createWorkspaceIdentity(process.cwd()),
        effects: {
          async appendIntent(intent) {
            captured = intent;
            order.push("intent");
            return { version: "tool-effect-append-receipt-v1", status: "accepted" };
          },
          async appendSettlement(settlement) {
            order.push(`settlement:${settlement.status}`);
            return { version: "tool-effect-append-receipt-v1", status: "accepted" };
          },
        },
      },
    });

    await executor(makeCall("write", { path: "effect-test.txt" }));

    expect(order).toEqual(["intent", "act", "settlement:failed"]);
    expect(captured?.execution).toEqual({ sessionId: "session-1", runId: "attempt-1" });
    expect(captured?.effectId).toBe(`tool-effect:${captured?.sourceRef}`);
  });

  it("does not act when the durable intent transition is rejected", async () => {
    let acted = false;
    const executor = createToolExecutor({
      tools: [
        {
          ...makeReadTool(),
          spec: { name: "write", inputSchema: { type: "object", properties: {} } },
          isReadOnly: false,
          execute: async (call) => {
            acted = true;
            return { id: "unexpected", toolCallId: call.id, output: "unexpected" };
          },
        },
      ],
      config: {
        runtime: { sessionId: "session-1", runId: "attempt-1" },
        workspaceIdentity: createWorkspaceIdentity(process.cwd()),
        effects: {
          async appendIntent() {
            return {
              version: "tool-effect-append-receipt-v1",
              status: "rejected",
              reason: "operation has no exact intent-producing native transition",
            };
          },
          async appendSettlement() {
            throw new Error("settlement must not be attempted");
          },
        },
      },
    });

    const result = await executor(makeCall("write", { path: "effect-test.txt" }));

    expect(acted).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("operation has no exact intent-producing native transition");
  });
});
