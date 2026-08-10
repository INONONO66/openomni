import { describe, expect, it, mock } from "bun:test";
import { PolicyEngine } from "../../../src/core/policy";
import type { PolicyContext } from "../../../src/core/policy";
import { abortRun, allow, deny } from "../../helpers/policy-decision";

function baseCtx(): Omit<PolicyContext, "timing"> & {
  sessionId: string;
  runId: string;
  toolId: string;
  toolInput: Record<string, unknown>;
} {
  return {
    sessionId: "session",
    runId: "run",
    toolId: "shell",
    toolInput: { command: "ls" },
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
  };
}

function env(): Record<string, string | undefined> {
  return (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process
    .env;
}

describe("PolicyEngine deny terminal dispatch", () => {
  it("stops dispatch on deny and preserves reason and policyId", async () => {
    const engine = PolicyEngine.create();
    const after = mock(() => abortRun("test.late", "late"));

    engine.register({
      kind: "point",
      name: "deny-first",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["audit.annotate"] },
      priority: 0,
      fn: () => deny("test.deny-first", "blocked"),
    });
    engine.register({
      kind: "point",
      name: "after",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["run.abort"] },
      priority: 10,
      fn: after,
    });

    const verdict = await engine.dispatchPoint("tool.native.pre", baseCtx());

    expect(verdict.verdict).toBe("deny");
    expect(verdict.policyId).toBe("agent.policy.composed");
    expect(verdict.reasonCodes).toContain("blocked");
    expect(after).toHaveBeenCalledTimes(0);
  });

  it("allows continue verdicts without policy metadata at pre-boundary points", async () => {
    const previousNodeEnv = env().NODE_ENV;
    env().NODE_ENV = "production";
    try {
      const engine = PolicyEngine.create();
      const after = mock(() => allow());

      engine.register({
        kind: "point",
        name: "missing-policy-id",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": [] },
        priority: 0,
        fn: () => allow(),
      });
      engine.register({
        kind: "point",
        name: "after",
        pointIds: ["tool.native.pre"],
        effectCapabilities: { "tool.native.pre": [] },
        priority: 10,
        fn: after,
      });

      const verdict = await engine.dispatchPoint("tool.native.pre", baseCtx());

      expect(verdict.verdict).toBe("allow");
      expect(after).toHaveBeenCalledTimes(1);
    } finally {
      if (previousNodeEnv === undefined) {
        delete env().NODE_ENV;
      } else {
        env().NODE_ENV = previousNodeEnv;
      }
    }
  });
});
