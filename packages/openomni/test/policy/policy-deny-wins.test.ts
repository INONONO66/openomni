import { describe, expect, test } from "bun:test";
import { PolicyEngine, type PolicyContext, type PolicyRegistration } from "@openomni/agent";
import { PolicyDecision, type Ingress, type RuntimeResource } from "@openomni/protocol";
import { buildWorkerMiddleware } from "../../src/execution-runtime/middleware";
import { IngressAuthorityMiddleware } from "../../src/ingress/middleware/ingress-authority";

const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

type PreDispatchContext = Omit<PolicyContext, "timing"> & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
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

function makeInboundEvent(overrides?: Partial<Ingress.InboundEvent>): Ingress.InboundEvent {
  return {
    id: "evt-1",
    surface: "test",
    mode: "direct",
    agent: {
      model: { provider: "test", id: "test-model" },
    },
    ...overrides,
  } as Ingress.InboundEvent;
}

const stubCoordinator = {
  dispatch: async () => ({
    runId: "run-stub",
    sessionId: "session-stub",
    status: "succeeded" as const,
    output: "ok",
    finishReason: "stop",
  }),
};

describe("cross-middleware deny-wins", () => {
  test("deny-wins across policy engine boundaries with mixed verdicts", async () => {
    const engine = PolicyEngine.create({ audit: false });

    const allowPolicy: PolicyRegistration = {
      name: "allow-policy",
      timing: "invoke.prepare",
      priority: 0,
      failPolicy: "fail-closed",
      fn: () => PolicyDecision.allow({ policyId: "allow-policy", reasonCodes: ["allowed"] }),
    };

    const denyPolicy: PolicyRegistration = {
      name: "deny-policy",
      timing: "invoke.prepare",
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

    const verdict = await engine.dispatch("invoke.prepare", {
      ...baseCtx(),
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

    const verdict = await engine.dispatch("invoke.prepare", {
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

  test("ingress deny blocks entire pipeline regardless of downstream allowances", async () => {
    const event = makeInboundEvent({
      meta: { actor: { role: "sub_persona" } },
    });

    await expect(
      IngressAuthorityMiddleware.runRoutedPreRun({
        event,
        coordinator: stubCoordinator,
      }),
    ).rejects.toThrow("actor is not authorized to create top-level inbound work");
  });
});
