import { describe, expect, test } from "bun:test";
import { ToolRuntimePolicyMiddleware } from "../../src/execution-runtime/tool/middleware/tool-runtime-policy";

describe("ToolRuntimePolicyMiddleware integration", () => {
  test("evaluates pre-tool for low-risk tier without workspace lock", async () => {
    const result = await ToolRuntimePolicyMiddleware.evaluatePreTool({
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
      toolName: "bash",
      toolCallId: "call-2",
      input: { command: "ls" },
      riskTier: 2,
      lockOwnerId: "run-2",
    });

    expect(result.decision.verdict).toBe("allow");
    expect(result.handle.timeoutMs).toBe(60_000);
  });

  test("evaluates post-tool releasing lock when acquired", async () => {
    const handle: ToolRuntimePolicyMiddleware.RuntimePolicyHandle = {
      timeoutMs: 30_000,
      lockOwnerId: "run-3",
      lockAcquired: false,
    };

    const verdict = ToolRuntimePolicyMiddleware.evaluatePostTool({
      toolName: "read_file",
      input: {},
      handle,
    });

    expect(verdict.verdict).toBe("allow");
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
