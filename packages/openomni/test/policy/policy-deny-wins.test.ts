import { describe, expect, test } from "bun:test";
import {
  PolicyEngine,
  type CanonicalPolicyRegistration,
  type PolicyContext,
} from "@openomni/agent";
import { PolicyDecision, type Policy } from "@openomni/protocol";
import { buildWorkerMiddleware } from "../../src/execution-runtime/middleware";

// #707 seam flip: the ingress arm of this suite (IngressAuthorityMiddleware
// deny aborting the pipeline) moved with the middleware to
// packages/channels/test/router/policy-deny-wins.test.ts. The brain-side
// arms (policy engine composition, worker middleware) stay here.

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

type PreDispatchContext = Omit<PolicyContext, "timing"> & {
  readonly resourceDescriptor?: Policy.Resource.Descriptor;
};

function baseCtx(overrides?: Partial<PreDispatchContext>): PreDispatchContext {
  return {
    steps: [],
    usage: emptyUsage,
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

describe("cross-middleware deny-wins", () => {
  test("deny-wins across policy engine boundaries with mixed verdicts", async () => {
    const engine = PolicyEngine.create({ audit: false });

    const allowPolicy: CanonicalPolicyRegistration = {
      kind: "point",
      name: "allow-policy",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": [] },
      priority: 0,
      failPolicy: "fail-closed",
      fn: () => PolicyDecision.allow({ policyId: "allow-policy", reasonCodes: ["allowed"] }),
    };

    const denyPolicy: CanonicalPolicyRegistration = {
      kind: "point",
      name: "deny-policy",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["run.abort"] },
      priority: 10,
      failPolicy: "fail-closed",
      fn: () =>
        PolicyDecision.deny({
          policyId: "deny-policy",
          reasonCodes: ["denied by policy"],
          effects: [{ type: "run.abort", reason: "denied by policy" }],
        }),
    };

    engine.register(allowPolicy);
    engine.register(denyPolicy);

    const verdict = await engine.dispatchPoint("tool.native.pre", {
      ...baseCtx(),
      sessionId: "session",
      runId: "run",
      toolId: "some_tool",
      toolName: "some_tool",
      toolInput: {},
    });

    expect(verdict.verdict).toBe("deny");
    expect(verdict.policyId).toBe("agent.policy.composed");
    expect(verdict.reasonCodes).toContain("denied by policy");
  });

  test("worker middleware deny + tool runtime continue → overall deny", async () => {
    const workerRegs = buildWorkerMiddleware({
      permissions: { action: "tool.call", allowlist: ["read_file"] },
    });
    const engine = PolicyEngine.create({ audit: false });
    for (const reg of workerRegs) engine.register(reg);

    const verdict = await engine.dispatchPoint("tool.native.pre", {
      ...baseCtx(),
      sessionId: "session-worker-middleware",
      runId: "run-worker-middleware",
      toolName: "bash",
      toolId: "bash",
      toolCallId: "call-bash",
      toolInput: { command: "rm -rf /" },
    });

    expect(verdict.verdict).toBe("deny");
    expect(PolicyDecision.reason(verdict)).toBe("allowlist_miss");
  });
});
