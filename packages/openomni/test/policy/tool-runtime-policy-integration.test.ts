import { describe, expect, test } from "bun:test";
import { ToolRuntimePolicyMiddleware } from "../../src/execution-runtime/tool/middleware/tool-runtime-policy";
import { WorkspaceLock } from "../../src/execution-runtime/workspace-lock";

describe("ToolRuntimePolicyMiddleware integration", () => {
  test("evaluates pre-tool for low-risk tier without workspace lock", async () => {
    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      traceContext: { traceId: "trace-policy-test", sessionId: "session-1", runId: "run-1" },
      toolName: "read_file",
      toolCallId: "call-1",
      input: { path: "/tmp/test.txt" },
      riskTier: 0,
      lockOwnerId: "run-1",
    });

    expect(result.decision.verdict).toBe("allow");
    expect(result.handle.lockAcquired).toBe(false);
    expect(result.handle.timeoutMs).toBe(30_000);
  });

  test("evaluates pre-tool for high-risk tier with timeout escalation", async () => {
    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      traceContext: { traceId: "trace-policy-test", sessionId: "session-1", runId: "run-1" },
      toolName: "bash",
      toolCallId: "call-2",
      input: { command: "ls" },
      riskTier: 2,
      lockOwnerId: "run-2",
    });

    expect(result.decision.verdict).toBe("allow");
    expect(result.handle.timeoutMs).toBe(60_000);
  });

  test("evaluates post-tool releasing an acquired lock", async () => {
    const workspaceRoot = `/tmp/openomni-runtime-policy-${crypto.randomUUID()}`;
    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      traceContext: { traceId: "trace-policy-test", sessionId: "session-1", runId: "run-1" },
      toolName: "write_file",
      toolCallId: "call-3",
      input: {},
      riskTier: 1,
      workspaceRoot,
      lockOwnerId: "run-3",
    });

    expect(result.handle.lockAcquired).toBe(true);
    try {
      const blocked = await WorkspaceLock.acquire(workspaceRoot, "contender", 10).catch(
        (error) => error,
      );
      expect(blocked).toBeInstanceOf(Error);

      const verdict = ToolRuntimePolicyMiddleware.evaluatePostTool({
        toolName: "write_file",
        input: {},
        handle: result.handle,
      });

      expect(verdict.verdict).toBe("allow");
      expect(result.handle.lockAcquired).toBe(false);
      await WorkspaceLock.acquire(workspaceRoot, "probe", 50);
      WorkspaceLock.release(workspaceRoot, "probe");
    } finally {
      if (result.handle.lockAcquired) {
        ToolRuntimePolicyMiddleware.evaluatePostTool({
          toolName: "write_file",
          input: {},
          handle: result.handle,
        });
      }
      WorkspaceLock.release(workspaceRoot, "probe");
      WorkspaceLock.release(workspaceRoot, "contender");
    }
  });

  test("enforceTimeout rejects after specified ms", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("done"), 500));

    await expect(ToolRuntimePolicyMiddleware.enforceTimeout(slow, 10)).rejects.toThrow(
      "timeout after 10ms",
    );
  });

  test("enforceTimeout resolves if promise completes in time", async () => {
    const fast = Promise.resolve("ok");

    const result = await ToolRuntimePolicyMiddleware.enforceTimeout(fast, 5_000);
    expect(result).toBe("ok");
  });

  test("TimeoutError carries the timeout duration", () => {
    const error = new ToolRuntimePolicyMiddleware.TimeoutError(42);
    expect(error.timeoutMs).toBe(42);
    expect(error.name).toBe("TimeoutError");
    expect(error.message).toBe("timeout after 42ms");
  });

  test("custom timeout config overrides default tier timeouts", async () => {
    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
      traceContext: { traceId: "trace-policy-test", sessionId: "session-1", runId: "run-1" },
      toolName: "write_file",
      input: {},
      riskTier: 1,
      lockOwnerId: "run-4",
      timeoutConfig: { tier1: 5_000 },
    });

    expect(result.handle.timeoutMs).toBe(5_000);
  });

  test("collects decisions via onDecision callback", async () => {
    const decisions: unknown[] = [];

    await ToolRuntimePolicyMiddleware.evaluatePreTool({
      traceContext: { traceId: "trace-policy-test", sessionId: "session-1", runId: "run-1" },
      toolName: "bash",
      input: { command: "echo hi" },
      riskTier: 2,
      lockOwnerId: "run-5",
      onDecision: (d) => {
        decisions.push(d);
      },
    });

    expect(decisions.length).toBeGreaterThan(0);
    for (const d of decisions) {
      expect(d).toHaveProperty("verdict");
    }
  });
});
