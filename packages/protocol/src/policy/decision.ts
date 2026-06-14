import type { PolicyEffects } from "./effects.js";
import type { PolicyPermission } from "./permission.js";

interface PolicyDecisionOptions {
  readonly policyId: string;
  readonly effects?: PolicyEffects.PolicyEffect[];
  readonly reasonCodes?: string[];
  readonly obligations?: PolicyEffects.PolicyObligation[];
  readonly factsUsed?: string[];
  readonly durationMs?: number;
  readonly priority?: number;
}

export namespace PolicyDecisionHelpers {
  function create(
    verdict: PolicyEffects.PolicyDecision["verdict"],
    options: PolicyDecisionOptions,
  ): PolicyEffects.PolicyDecision {
    return {
      policyId: options.policyId,
      verdict,
      effects: options.effects ?? [],
      reasonCodes: options.reasonCodes ?? [],
      ...(options.obligations !== undefined && { obligations: options.obligations }),
      ...(options.factsUsed !== undefined && { factsUsed: options.factsUsed }),
      ...(options.durationMs !== undefined && { durationMs: options.durationMs }),
      ...(options.priority !== undefined && { priority: options.priority }),
    };
  }

  export function allow(options: PolicyDecisionOptions): PolicyEffects.PolicyDecision {
    return create("allow", options);
  }

  export function deny(options: PolicyDecisionOptions): PolicyEffects.PolicyDecision {
    return create("deny", options);
  }

  export function pending(options: PolicyDecisionOptions): PolicyEffects.PolicyDecision {
    return create("pending", options);
  }

  export function isBlocking(decision: PolicyEffects.PolicyDecision): boolean {
    return decision.verdict !== "allow";
  }

  export function reason(
    decision: PolicyEffects.PolicyDecision,
    fallback: string = decision.verdict,
  ): string {
    return decision.reasonCodes[0] ?? fallback;
  }

  export function fromEvaluation(
    result: PolicyPermission.EvaluationResult,
    options: {
      readonly policyId?: string;
      readonly denyEffect?: PolicyEffects.PolicyEffect;
    } = {},
  ): PolicyEffects.PolicyDecision {
    const policyId = options.policyId ?? result.policyId;
    const reasonCodes = [result.reason];
    if (result.decision === "require_approval") {
      return pending({
        policyId,
        reasonCodes,
        effects: [{ type: "tool.require_approval", reason: result.reason }],
        obligations: [
          {
            obligationId: `${policyId}.approval`,
            type: "humanApproval",
            description: result.reason,
          },
        ],
      });
    }

    if (result.action === "continue") return allow({ policyId, reasonCodes });

    return deny({
      policyId,
      reasonCodes,
      effects: [
        options.denyEffect ?? { type: "run.abort", reason: result.reason },
        { type: "audit.annotate", annotation: result.reason, severity: "error" },
      ],
    });
  }
}
