import { describe, expect, it } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { composeEffects } from "../../../src/core/policy/effect-composition";

interface DecisionOptions {
  readonly policyId: string;
  readonly verdict?: Policy.PolicyDecision["verdict"];
  readonly effects?: Policy.PolicyEffect[];
  readonly obligations?: Policy.PolicyObligation[];
  readonly reasonCodes?: string[];
  readonly priority?: number;
}

function decision(options: DecisionOptions): Policy.PolicyDecision {
  const result = {
    policyId: options.policyId,
    verdict: options.verdict ?? "allow",
    effects: options.effects ?? [],
    ...(options.obligations !== undefined && { obligations: options.obligations }),
    reasonCodes: options.reasonCodes ?? [`${options.policyId}.matched`],
    ...(options.priority !== undefined && { priority: options.priority }),
  };

  return result;
}

describe("composeEffects", () => {
  it("treats deny as absorbing and pending as stronger than allow", () => {
    const obligation: Policy.PolicyObligation = {
      obligationId: "approval:workspace-write",
      type: "humanApproval",
      description: "Approve workspace write access.",
    };

    const pending = composeEffects([
      decision({
        policyId: "policy.prompt",
        effects: [{ type: "prompt.append_context", context: "Prefer safe tools." }],
      }),
      decision({
        policyId: "policy.approval",
        verdict: "pending",
        effects: [{ type: "tool.require_approval", reason: "workspace write" }],
        obligations: [obligation],
      }),
    ]);

    expect(pending.verdict).toBe("pending");
    expect(pending.obligations).toEqual([obligation]);

    const denied = composeEffects([
      decision({
        policyId: "policy.prompt",
        effects: [{ type: "prompt.append_context", context: "This must not survive deny." }],
      }),
      decision({
        policyId: "policy.approval",
        verdict: "pending",
        obligations: [obligation],
      }),
      decision({
        policyId: "policy.deny",
        verdict: "deny",
        effects: [
          { type: "runtime.set_timeout", timeoutMs: 1_000 },
          { type: "audit.annotate", annotation: "blocked dangerous operation", severity: "error" },
        ],
      }),
    ]);

    expect(denied.verdict).toBe("deny");
    expect(denied.obligations).toEqual([]);
    expect(denied.mergedEffects).toEqual([
      { type: "audit.annotate", annotation: "blocked dangerous operation", severity: "error" },
    ]);
  });

  it("fails closed on pre-boundary rewrite conflicts", () => {
    const result = composeEffects([
      decision({
        policyId: "policy.safe-command",
        effects: [{ type: "tool.rewrite_input", input: { command: "pwd" } }],
      }),
      decision({
        policyId: "policy.audit-command",
        effects: [{ type: "tool.rewrite_input", input: { command: "ls" } }],
      }),
    ]);

    expect(result.verdict).toBe("deny");
    expect(result.mergedEffects).toEqual([
      {
        type: "audit.annotate",
        annotation:
          "policy.effect_conflict.fail_closed: tool.rewrite_input.command rewritten by policy.audit-command and policy.safe-command",
        severity: "error",
      },
    ]);
  });

  it("keeps post-boundary conflicts diagnostic-only", () => {
    const result = composeEffects([
      decision({
        policyId: "policy.redact",
        effects: [{ type: "writeback.rewrite", output: "Redacted output." }],
      }),
      decision({
        policyId: "policy.suppress",
        effects: [{ type: "writeback.suppress", reason: "contains sensitive content" }],
      }),
    ]);

    expect(result.verdict).toBe("allow");
    expect(result.mergedEffects).toEqual([
      { type: "writeback.suppress", reason: "contains sensitive content" },
      {
        type: "audit.annotate",
        annotation:
          "policy.effect_conflict.post_boundary: writeback.suppress conflicts with writeback.rewrite from policy.redact and policy.suppress",
        severity: "warning",
      },
    ]);
  });

  it("merges scalar constraints to safer bounds", () => {
    const result = composeEffects([
      decision({
        policyId: "policy.generous",
        effects: [
          { type: "runtime.set_timeout", timeoutMs: 30_000 },
          { type: "run.retry_after", delayMs: 1_000, maxRetries: 3 },
          { type: "runtime.workspace_lock", required: false },
        ],
      }),
      decision({
        policyId: "policy.strict",
        effects: [
          { type: "runtime.set_timeout", timeoutMs: 5_000 },
          { type: "run.retry_after", delayMs: 5_000, maxRetries: 1 },
          { type: "runtime.workspace_lock", required: true },
        ],
      }),
    ]);

    expect(result.verdict).toBe("allow");
    expect(
      result.mergedEffects.some(
        (effect) => effect.type === "runtime.set_timeout" && effect.timeoutMs === 5_000,
      ),
    ).toBe(true);
    expect(
      result.mergedEffects.some(
        (effect) =>
          effect.type === "run.retry_after" && effect.delayMs === 5_000 && effect.maxRetries === 1,
      ),
    ).toBe(true);
    expect(
      result.mergedEffects.some(
        (effect) => effect.type === "runtime.workspace_lock" && effect.required,
      ),
    ).toBe(true);
  });

  it("orders prompt appends deterministically and deduplicates exact effects", () => {
    const result = composeEffects([
      decision({
        policyId: "policy.beta",
        priority: 20,
        effects: [{ type: "prompt.append_context", context: "second" }],
      }),
      decision({
        policyId: "policy.gamma",
        priority: 10,
        effects: [{ type: "prompt.append_context", context: "third" }],
      }),
      decision({
        policyId: "policy.alpha",
        priority: 20,
        effects: [
          { type: "prompt.append_context", context: "first" },
          { type: "prompt.append_context", context: "first" },
        ],
      }),
    ]);

    expect(result.verdict).toBe("allow");
    expect(result.mergedEffects).toEqual([
      { type: "prompt.append_context", context: "first" },
      { type: "prompt.append_context", context: "second" },
      { type: "prompt.append_context", context: "third" },
    ]);
  });
});
