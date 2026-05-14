import { describe, expect, it } from "bun:test";
import { PolicyEngine, defaultRegistry, type PolicyContext } from "@openomni/agent";
import type { Policy } from "@openomni/protocol";
import { buildWorkerMiddleware } from "../../src/execution-runtime/middleware";
import { PolicyResolver } from "../../src/policy";

function baseCtx(
  overrides?: Partial<Omit<PolicyContext, "timing">>,
): Omit<PolicyContext, "timing"> {
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

    const registry = defaultRegistry();
    registry.register("test:github-surface-guard", () => ({
      name: "test:github-surface-guard",
      timing: "turn.start",
      priority: 0,
      failPolicy: "fail-closed",
      fn: (ctx) => {
        const hasGitHubLabel =
          ctx.labels?.some((label) => label.value === "surface.github") ?? false;
        if (hasGitHubLabel) {
          return {
            action: "abort",
            reason: "github_surface_requires_explicit_review_mode",
            policyId: "test:github-surface-guard",
          };
        }
        return { action: "continue" };
      },
    }));

    const registrations = registry.resolve(plan, { agentName: "reviewer" });
    expect(registrations.map((registration) => registration.name)).toContain(
      "test:github-surface-guard",
    );

    const engine = PolicyEngine.create({ audit: false });
    for (const registration of registrations) engine.register(registration);

    const verdict = await engine.dispatch(
      "turn.start",
      baseCtx({ agentType: "reviewer", labels: labelEntries(plan.labels) }),
    );

    expect(verdict).toEqual({
      action: "abort",
      reason: "github_surface_requires_explicit_review_mode",
      policyId: "test:github-surface-guard",
    });
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

    const registry = defaultRegistry();
    registry.register("policy:github-review-readonly", () => ({
      name: "policy:github-review-readonly",
      timing: "invoke.prepare",
      priority: -10,
      failPolicy: "fail-closed",
      fn: (ctx) => {
        const isWriteTool = ctx.toolLabels?.includes("capability.write") ?? false;
        if (isWriteTool) {
          return {
            action: "abort",
            reason: "reviewer_read_only",
            policyId: "policy:github-review-readonly",
          };
        }
        return { action: "continue" };
      },
    }));

    const engine = PolicyEngine.create({ audit: false });
    for (const registration of registry.resolve(plan, { agentName: "reviewer" })) {
      engine.register(registration);
    }

    const verdict = await engine.dispatch(
      "invoke.prepare",
      baseCtx({
        agentType: "reviewer",
        labels: labelEntries(plan.labels),
        toolName: "github.create_review_comment",
        toolCallId: "call-review-comment",
        toolLabels: ["surface.github", "capability.write"],
        toolInput: { body: "Please change this implementation." },
      }),
    );

    expect(verdict).toEqual({
      action: "abort",
      reason: "reviewer_read_only",
      policyId: "policy:github-review-readonly",
    });
  });

  it("keeps permissions-only worker middleware working end-to-end", async () => {
    const registrations = buildWorkerMiddleware({
      permissions: { action: "tool.call", allowlist: ["github.read_issue"] },
    });
    const engine = PolicyEngine.create({ audit: false });
    for (const registration of registrations) engine.register(registration);

    const verdict = await engine.dispatch(
      "invoke.prepare",
      baseCtx({
        toolName: "github.create_issue_comment",
        toolCallId: "call-comment",
        toolLabels: ["surface.github", "capability.write"],
        toolInput: { body: "Looks good." },
      }),
    );

    expect(verdict.action).toBe("abort");
    expect("decision" in verdict ? verdict.decision : undefined).toBe("deny");
    expect(verdict.reason).toBe("allowlist_miss");
    expect(verdict.policyId).toBe("guardrail.permission");
  });

  it("fails closed when a required policy is not registered", () => {
    const plan: Policy.PolicyPlan = {
      policies: [{ id: "policy:missing-required", required: true }],
      labels: ["agent:reviewer", "surface:github"],
    };

    expect(() => defaultRegistry().resolve(plan, { agentName: "reviewer" })).toThrow(
      "Required policy 'policy:missing-required' is not registered",
    );
  });
});
