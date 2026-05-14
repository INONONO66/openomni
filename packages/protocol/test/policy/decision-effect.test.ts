import { describe, expect, test } from "bun:test";
import { Policy } from "../../src/policy/index";

const it = test;

describe("Policy decision and effect schemas", () => {
  const effects = [
    { type: "prompt.append_context", context: "Prefer concise answers." },
    { type: "prompt.inject_message", message: "Use read-only tools.", role: "user" },
    { type: "prompt.replace", prompt: "You are running in locked-down mode." },
    { type: "tool.filter", toolPattern: "system.bash" },
    { type: "tool.rewrite_input", input: { command: "pwd" } },
    { type: "tool.skip_invocation", reason: "tool denied by policy" },
    { type: "tool.require_approval", reason: "writes workspace files" },
    { type: "run.abort", reason: "budget exceeded" },
    { type: "run.continue_with_prompt", prompt: "Ask for confirmation first." },
    { type: "run.retry_after", delayMs: 1_000, maxRetries: 2 },
    { type: "delegation.set_constraints", constraints: { maxDepth: 1 } },
    { type: "delegation.require_approval", reason: "external delegate" },
    { type: "audit.annotate", annotation: "policy matched", severity: "info" },
    { type: "writeback.rewrite", output: "Redacted final response." },
    { type: "writeback.suppress", reason: "contains sensitive content" },
    { type: "runtime.set_timeout", timeoutMs: 30_000 },
    { type: "runtime.workspace_lock", required: true },
  ];

  it("parses every supported PolicyEffect variant", () => {
    for (const effect of effects) {
      expect(Policy.PolicyEffect.parse(effect)).toEqual(effect);
    }
  });

  it("rejects unknown effect types", () => {
    expect(
      Policy.PolicyEffect.safeParse({
        type: "tool.invoke",
        toolName: "system.bash",
      }).success,
    ).toBe(false);
  });

  it("parses PolicyDecision with effects and obligations", () => {
    const decision = Policy.PolicyDecision.parse({
      policyId: "policy.workspace-safety",
      policyVersion: "2026-05-14",
      verdict: "pending",
      effects: [effects[0], effects[6]],
      obligations: [
        {
          obligationId: "approval:workspace-write",
          type: "humanApproval",
          description: "Approve workspace write access.",
          timeoutMs: 60_000,
          resolvedBy: "user:ino",
        },
      ],
      reasonCodes: ["workspace_write_requires_approval"],
      factsUsed: ["resource.labels", "actor.permissions"],
      durationMs: 12,
    });

    expect(decision.verdict).toBe("pending");
    expect(decision.effects.length).toBe(2);
    expect(decision.obligations?.[0]?.type).toBe("humanApproval");
  });

  it("requires reason codes on PolicyDecision", () => {
    expect(
      Policy.PolicyDecision.safeParse({
        policyId: "policy.workspace-safety",
        verdict: "allow",
        effects: [],
      }).success,
    ).toBe(false);
  });

  it("parses PolicyObligation variants", () => {
    const obligationTypes: Policy.PolicyObligation["type"][] = [
      "humanApproval",
      "evidenceRequired",
      "credentialConfirm",
    ];

    for (const type of obligationTypes) {
      expect(
        Policy.PolicyObligation.parse({
          obligationId: `obligation:${type}`,
          type,
          description: "Resolve before continuing.",
        }),
      ).toMatchObject({ type });
    }
  });

  it("parses EffectiveDecision with merged effects and contributing policies", () => {
    const result = Policy.EffectiveDecision.parse({
      verdict: "allow",
      mergedEffects: [effects[12], effects[16]],
      obligations: [],
      contributingPolicies: ["policy.audit", "policy.timeout"],
    });

    expect(result.mergedEffects.length).toBe(2);
    expect(result.contributingPolicies).toEqual(["policy.audit", "policy.timeout"]);
  });
});
