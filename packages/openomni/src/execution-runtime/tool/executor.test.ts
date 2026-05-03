import { describe, expect, it } from "bun:test";
import type { Tool } from "@openomni/protocol";
import { createToolExecutor } from "./executor.js";
import { ToolRuntimePolicyMiddleware } from "./middleware/tool-runtime-policy.js";
import type { NativeTool, ToolRiskTier } from "./types.js";

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

describe("createToolExecutor", () => {
  it("dispatches to the correct tool and returns its result", async () => {
    const executor = createToolExecutor({
      tools: [
        makeTool("read", {
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

  it("denies tools matching the denylist", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash")],
      config: { permissions: { action: "tool.call", denylist: ["bash"] } },
    });

    const result = await executor(makeCall("bash"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("[Blocked]");
    expect(result.output).toContain("denied by policy");
  });

  it("denies tools absent from the allowlist", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("write"), makeTool("read")],
      config: { permissions: { action: "tool.call", allowlist: ["read"] } },
    });

    const writeResult = await executor(makeCall("write"));
    expect(writeResult.isError).toBe(true);
    expect(writeResult.output).toContain("[Blocked]");

    const readResult = await executor(makeCall("read"));
    expect(readResult.isError).toBeUndefined();
  });

  it("blocks tools that require approval", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash")],
      config: { permissions: { action: "tool.call", requireApproval: ["bash"] } },
    });

    const result = await executor(makeCall("bash"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("requires approval");
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

    const result = await executor(makeCall("fail"));

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

    const result = await executor(makeCall("slow"));

    expect(result.toolCallId).toBe("call-1");
    expect(result.isError).toBe(true);
    expect(result.output).toBe("timeout after 10ms");
  });

  it("dispatches to a dotted-name tool via its underscore alias", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("grep.search")],
    });

    const result = await executor(makeCall("grep_search"));

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("grep.search-ok");
  });

  it("denylist wildcard pattern blocks the entire tool family", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("file.read"), makeTool("file.write"), makeTool("bash")],
      config: { permissions: { action: "tool.call", denylist: ["file.*"] } },
    });

    const readResult = await executor(makeCall("file.read"));
    expect(readResult.isError).toBe(true);

    const writeResult = await executor(makeCall("file.write"));
    expect(writeResult.isError).toBe(true);

    const bashResult = await executor(makeCall("bash"));
    expect(bashResult.isError).toBeUndefined();
  });

  it("applies canonical star wildcard policy patterns", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("read"), makeTool("bash")],
      config: { permissions: { action: "tool.call", denylist: ["*"] } },
    });

    const readResult = await executor(makeCall("read"));
    expect(readResult.isError).toBe(true);
    expect(readResult.output).toContain("denylist");

    const bashResult = await executor(makeCall("bash"));
    expect(bashResult.isError).toBe(true);
    expect(bashResult.output).toContain("denylist");
  });

  it("applies guardrail input rule decisions", async () => {
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

    const result = await executor(makeCall("bash", { command: "rm -rf /tmp/example" }));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("dangerous_command");
  });

  it("no permissions config allows all tools", async () => {
    const executor = createToolExecutor({
      tools: [makeTool("bash"), makeTool("read")],
    });

    expect((await executor(makeCall("bash"))).isError).toBeUndefined();
    expect((await executor(makeCall("read"))).isError).toBeUndefined();
  });

  it("resolves risk-tier runtime policy with decision metadata", async () => {
    const decisions: string[] = [];

    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      toolName: "bash",
      toolCallId: "call-1",
      input: {},
      riskTier: 2,
      timeoutConfig: { tier2: 15 },
      lockOwnerId: "owner-1",
      onDecision: (decision) => {
        decisions.push(`${decision.policyId}:${decision.reason ?? ""}`);
      },
    });

    expect(result.verdict.action).toBe("continue");
    expect(result.verdict.policyId).toBe("tool.runtime-policy");
    expect(result.verdict.reason).toBe("runtime policy evaluated");
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

    await executor(makeCall("todo_write", { todos: [] }));
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
    await executor(makeCall("todo_write", { todos: [] }));
    expect(capturedInput.sessionId).toBeUndefined();
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
    await executor(makeCall("todo_write", { sessionId: "fake-session", todos: [] }));
    expect(capturedInput.sessionId).toBe("real-session");
  });
});
