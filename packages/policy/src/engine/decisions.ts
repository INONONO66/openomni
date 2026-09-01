import { Policy } from "@openomni/protocol";
import { composeEffects } from "../effects/compose";
import { allowedEffectTypesAtPoint } from "./points";
import type { PolicyPointId } from "./types";

export const COMPOSED_POLICY_ID = "agent.policy.composed";

type EffectMembership = {
  readonly has: (effectType: Policy.PolicyEffectType) => boolean;
};

function totalDurationMs(decisions: readonly Policy.PolicyDecision[]): number {
  return decisions.reduce((total, decision) => total + (decision.durationMs ?? 0), 0);
}

/**
 * A deny at a side-effect boundary auto-escalates: `run.abort` is injected so
 * a denial cannot be quietly downgraded to a diagnostic. Consumer honesty
 * note: the main production consumer (packages/agent
 * src/core/execution/tools.ts) honors the injected abort only at POST
 * boundaries (`tool.*.post`: blocking + run.abort → blocked result) and in
 * lifecycle dispatch; for `tool.*.pre` denials it blocks the single tool call
 * on the verdict alone and the run continues — the injected run.abort effect
 * is decorative there. The escalation semantics are a deliberate design
 * (deny-at-boundary must carry its strongest effect); whether run.abort ends
 * the run is the consumer's choice per point.
 */
function enforceDenyAbort(
  decision: Policy.PolicyDecision,
  allowed: EffectMembership,
  sideEffectBoundary: boolean,
): Policy.PolicyDecision {
  if (decision.verdict !== "deny") return decision;
  if (decision.effects.some((effect) => effect.type === "run.abort")) return decision;
  if (!sideEffectBoundary || !allowed.has("run.abort")) return decision;

  const reason = decision.reasonCodes[0] ?? "policy.deny";
  return {
    ...decision,
    effects: [{ type: "run.abort", reason }, ...decision.effects],
  };
}

function composedDecision(
  effective: Policy.EffectiveDecision,
  decisions: readonly Policy.PolicyDecision[],
): Policy.PolicyDecision {
  const reasonSources =
    effective.verdict === "allow"
      ? decisions
      : decisions.filter((decision) => decision.verdict === effective.verdict);
  const reasonCodes = reasonSources.flatMap((decision) => decision.reasonCodes);
  const obligations = effective.obligations.length === 0 ? undefined : effective.obligations;

  return {
    policyId: COMPOSED_POLICY_ID,
    verdict: effective.verdict,
    effects: effective.mergedEffects,
    ...(obligations !== undefined && { obligations }),
    reasonCodes: [...new Set(reasonCodes)],
    durationMs: totalDurationMs(decisions),
  };
}

export function composeFinalPointDecision(
  decisions: readonly Policy.PolicyDecision[],
  pointId: PolicyPointId,
): Policy.PolicyDecision {
  const contract = Policy.PolicyPoint.Registry[pointId];
  const allowed = allowedEffectTypesAtPoint(pointId);
  const effective = composeEffects([...decisions]);
  const decision = composedDecision(effective, decisions);
  return enforceDenyAbort(decision, allowed, contract.sideEffectBoundary);
}
