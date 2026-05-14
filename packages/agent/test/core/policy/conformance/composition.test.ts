import { describe, expect, it } from "bun:test";
import type { Policy } from "@openomni/protocol";
import { composeEffects } from "../../../../src/core/policy/effect-composition";

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

const humanApproval: Policy.PolicyObligation = {
  obligationId: "approval:workspace-write",
  type: "humanApproval",
  description: "Approve workspace write access.",
};

describe("policy composition conformance", () => {
  describe("verdict precedence", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly decisions: Policy.PolicyDecision[];
      readonly expectedVerdict: Policy.EffectiveDecision["verdict"];
      readonly expectedObligations: Policy.PolicyObligation[];
    }> = [
      {
        name: "empty policy set allows without effects",
        decisions: [],
        expectedVerdict: "allow",
        expectedObligations: [],
      },
      {
        name: "single allow remains allow",
        decisions: [
          decision({
            policyId: "policy.allow",
            effects: [{ type: "prompt.append_context", context: "Use safe defaults." }],
          }),
        ],
        expectedVerdict: "allow",
        expectedObligations: [],
      },
      {
        name: "all allow remains allow",
        decisions: [decision({ policyId: "policy.alpha" }), decision({ policyId: "policy.beta" })],
        expectedVerdict: "allow",
        expectedObligations: [],
      },
      {
        name: "pending wins over allow",
        decisions: [
          decision({ policyId: "policy.allow" }),
          decision({
            policyId: "policy.pending",
            verdict: "pending",
            effects: [{ type: "tool.require_approval", reason: "workspace write" }],
            obligations: [humanApproval],
          }),
        ],
        expectedVerdict: "pending",
        expectedObligations: [humanApproval],
      },
      {
        name: "deny wins over pending and allow",
        decisions: [
          decision({ policyId: "policy.allow" }),
          decision({
            policyId: "policy.pending",
            verdict: "pending",
            obligations: [humanApproval],
          }),
          decision({
            policyId: "policy.deny",
            verdict: "deny",
            effects: [{ type: "audit.annotate", annotation: "blocked", severity: "error" }],
          }),
        ],
        expectedVerdict: "deny",
        expectedObligations: [],
      },
      {
        name: "all deny remains deny",
        decisions: [
          decision({
            policyId: "policy.deny-a",
            verdict: "deny",
            effects: [{ type: "audit.annotate", annotation: "a", severity: "error" }],
          }),
          decision({
            policyId: "policy.deny-b",
            verdict: "deny",
            effects: [{ type: "audit.annotate", annotation: "b", severity: "error" }],
          }),
        ],
        expectedVerdict: "deny",
        expectedObligations: [],
      },
    ];

    for (const item of cases) {
      it(item.name, () => {
        const result = composeEffects(item.decisions);

        expect(result.verdict).toBe(item.expectedVerdict);
        expect(result.obligations).toEqual(item.expectedObligations);
      });
    }

    it("keeps only safe audit effects for deny decisions", () => {
      const result = composeEffects([
        decision({
          policyId: "policy.deny",
          verdict: "deny",
          effects: [
            { type: "runtime.set_timeout", timeoutMs: 1_000 },
            { type: "prompt.append_context", context: "not safe after deny" },
            {
              type: "audit.annotate",
              annotation: "blocked dangerous operation",
              severity: "error",
            },
          ],
        }),
      ]);

      expect(result).toEqual({
        verdict: "deny",
        mergedEffects: [
          { type: "audit.annotate", annotation: "blocked dangerous operation", severity: "error" },
        ],
        obligations: [],
        contributingPolicies: ["policy.deny"],
      });
    });
  });

  describe("effect ordering and deduplication", () => {
    it("orders effects by policy priority, then policyId", () => {
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
          effects: [{ type: "prompt.append_context", context: "first" }],
        }),
      ]);

      expect(result.mergedEffects).toEqual([
        { type: "prompt.append_context", context: "first" },
        { type: "prompt.append_context", context: "second" },
        { type: "prompt.append_context", context: "third" },
      ]);
      expect(result.contributingPolicies).toEqual(["policy.alpha", "policy.beta", "policy.gamma"]);
    });

    it("deduplicates exact duplicate effects by stable hash", () => {
      const duplicate: Policy.PolicyEffect = {
        type: "prompt.inject_message",
        role: "user",
        message: "Be careful.",
      };
      const result = composeEffects([
        decision({
          policyId: "policy.alpha",
          effects: [duplicate, duplicate],
        }),
        decision({
          policyId: "policy.beta",
          effects: [{ message: "Be careful.", role: "user", type: "prompt.inject_message" }],
        }),
      ]);

      expect(result.mergedEffects).toEqual([duplicate]);
    });
  });

  describe("conflict detection", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly decisions: Policy.PolicyDecision[];
      readonly expectedAnnotation: string;
    }> = [
      {
        name: "fails closed for incompatible tool rewrites",
        decisions: [
          decision({
            policyId: "policy.command-a",
            effects: [{ type: "tool.rewrite_input", input: { command: "pwd" } }],
          }),
          decision({
            policyId: "policy.command-b",
            effects: [{ type: "tool.rewrite_input", input: { command: "ls" } }],
          }),
        ],
        expectedAnnotation:
          "policy.effect_conflict.fail_closed: tool.rewrite_input.command rewritten by policy.command-a and policy.command-b",
      },
      {
        name: "fails closed for incompatible delegation constraints",
        decisions: [
          decision({
            policyId: "policy.delegate-a",
            effects: [{ type: "delegation.set_constraints", constraints: { maxDepth: 1 } }],
          }),
          decision({
            policyId: "policy.delegate-b",
            effects: [{ type: "delegation.set_constraints", constraints: { maxDepth: 2 } }],
          }),
        ],
        expectedAnnotation:
          "policy.effect_conflict.fail_closed: delegation.set_constraints.maxDepth rewritten by policy.delegate-a and policy.delegate-b",
      },
      {
        name: "fails closed for filter and approval conflicts",
        decisions: [
          decision({
            policyId: "policy.filter",
            effects: [{ type: "tool.filter", toolPattern: "shell.*" }],
          }),
          decision({
            policyId: "policy.approval",
            effects: [{ type: "tool.require_approval", reason: "shell access" }],
          }),
        ],
        expectedAnnotation:
          "policy.effect_conflict.fail_closed: tool.filter conflicts with tool.require_approval from policy.filter and policy.approval",
      },
      {
        name: "fails closed for incompatible scalar prompt replacement",
        decisions: [
          decision({
            policyId: "policy.prompt-a",
            effects: [{ type: "prompt.replace", prompt: "Prompt A" }],
          }),
          decision({
            policyId: "policy.prompt-b",
            effects: [{ type: "prompt.replace", prompt: "Prompt B" }],
          }),
        ],
        expectedAnnotation:
          "policy.effect_conflict.fail_closed: prompt.replace.prompt rewritten by policy.prompt-a and policy.prompt-b",
      },
    ];

    for (const item of cases) {
      it(item.name, () => {
        const result = composeEffects(item.decisions);

        expect(result.verdict).toBe("deny");
        expect(result.mergedEffects).toEqual([
          { type: "audit.annotate", annotation: item.expectedAnnotation, severity: "error" },
        ]);
      });
    }

    it("keeps post-boundary rewrite conflicts diagnostic-only", () => {
      const result = composeEffects([
        decision({
          policyId: "policy.rewrite-a",
          effects: [{ type: "writeback.rewrite", output: "Output A" }],
        }),
        decision({
          policyId: "policy.rewrite-b",
          effects: [{ type: "writeback.rewrite", output: "Output B" }],
        }),
      ]);

      expect(result.verdict).toBe("allow");
      expect(result.mergedEffects).toEqual([
        { type: "writeback.rewrite", output: "Output A" },
        {
          type: "audit.annotate",
          annotation:
            "policy.effect_conflict.post_boundary: writeback.rewrite.output rewritten by policy.rewrite-a and policy.rewrite-b",
          severity: "warning",
        },
      ]);
    });
  });

  describe("merge rules", () => {
    it("appends additive effects and unions filter patterns", () => {
      const result = composeEffects([
        decision({
          policyId: "policy.alpha",
          effects: [
            { type: "prompt.append_context", context: "alpha" },
            { type: "audit.annotate", annotation: "alpha-audit", severity: "info" },
            { type: "tool.filter", toolPattern: "shell.*" },
          ],
        }),
        decision({
          policyId: "policy.beta",
          effects: [
            { type: "prompt.append_context", context: "beta" },
            { type: "tool.filter", toolPattern: "network.*" },
          ],
        }),
      ]);

      expect(result.mergedEffects).toEqual([
        { type: "prompt.append_context", context: "alpha" },
        { type: "audit.annotate", annotation: "alpha-audit", severity: "info" },
        { type: "tool.filter", toolPattern: "shell.*" },
        { type: "prompt.append_context", context: "beta" },
        { type: "tool.filter", toolPattern: "network.*" },
      ]);
    });

    it("deep-merges compatible records", () => {
      const result = composeEffects([
        decision({
          policyId: "policy.alpha",
          effects: [{ type: "tool.rewrite_input", input: { env: { SAFE: "1" } } }],
        }),
        decision({
          policyId: "policy.beta",
          effects: [{ type: "tool.rewrite_input", input: { cwd: "/tmp" } }],
        }),
      ]);

      expect(result.verdict).toBe("allow");
      expect(result.mergedEffects).toEqual([
        { type: "tool.rewrite_input", input: { env: { SAFE: "1" }, cwd: "/tmp" } },
      ]);
    });

    it("chooses safer scalar bounds", () => {
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

      expect(
        result.mergedEffects.some(
          (effect) => effect.type === "runtime.set_timeout" && effect.timeoutMs === 5_000,
        ),
      ).toBe(true);
      expect(
        result.mergedEffects.some(
          (effect) =>
            effect.type === "run.retry_after" &&
            effect.delayMs === 5_000 &&
            effect.maxRetries === 1,
        ),
      ).toBe(true);
      expect(
        result.mergedEffects.some(
          (effect) => effect.type === "runtime.workspace_lock" && effect.required,
        ),
      ).toBe(true);
    });

    it("concatenates approval reasons", () => {
      const result = composeEffects([
        decision({
          policyId: "policy.alpha",
          effects: [
            { type: "tool.require_approval", reason: "workspace write" },
            { type: "delegation.require_approval", reason: "external worker" },
          ],
        }),
        decision({
          policyId: "policy.beta",
          effects: [
            { type: "tool.require_approval", reason: "network access" },
            { type: "delegation.require_approval", reason: "sensitive prompt" },
          ],
        }),
      ]);

      expect(
        result.mergedEffects.some(
          (effect) =>
            effect.type === "tool.require_approval" &&
            effect.reason === "workspace write; network access",
        ),
      ).toBe(true);
      expect(
        result.mergedEffects.some(
          (effect) =>
            effect.type === "delegation.require_approval" &&
            effect.reason === "external worker; sensitive prompt",
        ),
      ).toBe(true);
    });
  });

  it("is pure for identical inputs", () => {
    const decisions = [
      decision({
        policyId: "policy.alpha",
        priority: 10,
        effects: [
          { type: "prompt.append_context", context: "alpha" },
          { type: "runtime.set_timeout", timeoutMs: 5_000 },
        ],
      }),
      decision({
        policyId: "policy.beta",
        effects: [{ type: "audit.annotate", annotation: "beta", severity: "info" }],
      }),
    ];

    const first = composeEffects(decisions);
    const second = composeEffects(decisions);

    expect(second).toEqual(first);
    expect(decisions).toEqual([
      decision({
        policyId: "policy.alpha",
        priority: 10,
        effects: [
          { type: "prompt.append_context", context: "alpha" },
          { type: "runtime.set_timeout", timeoutMs: 5_000 },
        ],
      }),
      decision({
        policyId: "policy.beta",
        effects: [{ type: "audit.annotate", annotation: "beta", severity: "info" }],
      }),
    ]);
  });
});
