import { describe, expect, it } from "bun:test";
import { PolicyEngine, defaultRegistry, type PolicyContext } from "@openomni/agent";
import { registerIdleNudge } from "../../src/execution-runtime/middleware/idle-nudge-policy";
import { registerToolPermission } from "../../src/execution-runtime/middleware/tool-permission-policy";
import { PolicyDecision, type Policy } from "@openomni/protocol";
import { buildWorkerMiddleware } from "../../src/execution-runtime/middleware";
import { PolicyResolver } from "../../src/policy";
import { Bus } from "@openomni/telemetry";

type PreDispatchContext = Omit<PolicyContext, "timing"> & {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly toolId?: string;
};

function baseCtx(overrides?: Partial<PreDispatchContext>): PreDispatchContext {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: false,
    continuationCount: 0,
    elapsedMs: 0,
    ...overrides,
  };
}

function labelEntries(labels: readonly string[]): Policy.LabelEntry[] {
  return labels.map((value) => ({ value, source: "operator" }));
}

describe("policy pipeline integration", () => {
  it("runs labels through resolver, plan, registry, engine dispatch, and verdict", async () => {
    const resolver = PolicyResolver.create([
      {
        match: { all: ["surface.github"], any: ["agent.reviewer", "agent.coder"] },
        policies: ["test:github-surface-guard"],
        required: true,
      },
    ]);
    const plan = resolver.resolve({
      actorLabels: [{ value: "actor.owner", source: "operator" }],
      agentLabels: [{ value: "agent.reviewer", source: "agent_profile" }],
      runLabels: ["run.direct"],
      surfaceLabels: ["surface.github"],
    });

    expect(plan.policies.map((policy) => policy.id)).toEqual([
      "builtin:tool-permission",
      "builtin:idle-nudge",
      "test:github-surface-guard",
    ]);
    expect(plan.labels).toEqual(["actor.owner", "agent.reviewer", "run.direct", "surface.github"]);

    const registry = defaultRegistry(Bus);
    registerIdleNudge(registry);
    registerToolPermission(registry, Bus);
    registry.register("test:github-surface-guard", () => ({
      kind: "point",
      name: "test:github-surface-guard",
      pointIds: ["run.turn.pre"],
      effectCapabilities: { "run.turn.pre": ["run.abort"] },
      priority: 0,
      failPolicy: "fail-closed",
      fn: (ctx) => {
        const hasGitHubLabel =
          ctx.labels?.some((label) => label.value === "surface.github") ?? false;
        if (hasGitHubLabel) {
          return PolicyDecision.deny({
            policyId: "test:github-surface-guard",
            reasonCodes: ["github_surface_requires_explicit_review_mode"],
            effects: [
              { type: "run.abort", reason: "github_surface_requires_explicit_review_mode" },
            ],
          });
        }
        return PolicyDecision.allow({ policyId: "test:github-surface-guard" });
      },
    }));

    const registrations = registry.resolve(plan, { agentName: "reviewer" });
    expect(registrations.map((registration) => registration.name)).toContain(
      "test:github-surface-guard",
    );

    const engine = PolicyEngine.create({ audit: false });
    for (const registration of registrations) engine.register(registration);

    const verdict = await engine.dispatchPoint("run.turn.pre", {
      ...baseCtx({ agentType: "reviewer", labels: labelEntries(plan.labels) }),
      sessionId: "session",
      runId: "run",
      turnIndex: 0,
    });

    expect(verdict).toMatchObject({
      verdict: "deny",
      policyId: "agent.policy.composed",
    });
    expect(PolicyDecision.reason(verdict)).toBe("github_surface_requires_explicit_review_mode");
  });

  it("denies write tools for a reviewer agent on GitHub", async () => {
    const resolver = PolicyResolver.create([
      {
        match: { all: ["agent:reviewer", "surface:github"] },
        policies: ["policy:github-review-readonly"],
        required: true,
      },
    ]);
    const plan = resolver.resolve({
      actorLabels: ["actor:main"],
      agentLabels: ["agent:reviewer"],
      runLabels: ["run:review"],
      surfaceLabels: ["surface:github"],
    });

    const registry = defaultRegistry(Bus);
    registerIdleNudge(registry);
    registerToolPermission(registry, Bus);
    registry.register("policy:github-review-readonly", () => ({
      kind: "point",
      name: "policy:github-review-readonly",
      pointIds: ["tool.native.pre"],
      effectCapabilities: { "tool.native.pre": ["run.abort"] },
      // Canonical priorities are non-negative; legacy -10 renumbered to 0.
      // builtin:tool-permission (also priority 0, default config) allows this
      // tool, so the composed deny reason still comes from this policy.
      priority: 0,
      failPolicy: "fail-closed",
      fn: (ctx) => {
        const isWriteTool = ctx.toolLabels?.includes("capability.write") ?? false;
        if (isWriteTool) {
          return PolicyDecision.deny({
            policyId: "policy:github-review-readonly",
            reasonCodes: ["reviewer_read_only"],
            effects: [{ type: "run.abort", reason: "reviewer_read_only" }],
          });
        }
        return PolicyDecision.allow({ policyId: "policy:github-review-readonly" });
      },
    }));

    const engine = PolicyEngine.create({ audit: false });
    for (const registration of registry.resolve(plan, { agentName: "reviewer" })) {
      engine.register(registration);
    }

    const verdict = await engine.dispatchPoint("tool.native.pre", {
      ...baseCtx({
        agentType: "reviewer",
        labels: labelEntries(plan.labels),
        toolName: "github.create_review_comment",
        toolCallId: "call-review-comment",
        toolLabels: ["surface.github", "capability.write"],
      }),
      sessionId: "session",
      runId: "run",
      toolId: "github.create_review_comment",
      toolInput: { body: "Please change this implementation." },
    });

    expect(verdict).toMatchObject({
      verdict: "deny",
      policyId: "agent.policy.composed",
    });
    expect(PolicyDecision.reason(verdict)).toBe("reviewer_read_only");
  });

  it("keeps permissions-only worker middleware working end-to-end", async () => {
    const registrations = buildWorkerMiddleware({
      permissions: { action: "tool.call", allowlist: ["github.read_issue"] },
    });
    const engine = PolicyEngine.create({ audit: false });
    for (const registration of registrations) engine.register(registration);

    const verdict = await engine.dispatchPoint("tool.native.pre", {
      ...baseCtx({
        toolName: "github.create_issue_comment",
        toolCallId: "call-comment",
        toolLabels: ["surface.github", "capability.write"],
      }),
      sessionId: "session-permissions-only",
      runId: "run-permissions-only",
      toolId: "github.create_issue_comment",
      toolInput: { body: "Looks good." },
    });

    expect(verdict.verdict).toBe("deny");
    expect(PolicyDecision.reason(verdict)).toBe("allowlist_miss");
    expect(verdict.policyId).toBe("agent.policy.composed");
  });

  it("fails closed when a required policy is not registered", () => {
    const plan: Policy.PolicyPlan = {
      policies: [{ id: "policy:missing-required", required: true }],
      labels: ["agent:reviewer", "surface:github"],
    };

    expect(() => defaultRegistry(Bus).resolve(plan, { agentName: "reviewer" })).toThrow(
      "Required policy 'policy:missing-required' is not registered",
    );
  });
});
