import { Policy, PolicyDecision } from "@openomni/protocol";
import type { PolicyPointId } from "./types";

const ENFORCEMENT_POLICY_ID = "policy.point.contract";

type RegistrationMeta = { readonly name: string; readonly priority: number };

function enforcementEffects(pointId: PolicyPointId, reason: string): Policy.PolicyEffect[] {
  const contract = Policy.PolicyPoint.Registry[pointId];
  return [
    ...(contract.sideEffectBoundary && contract.allowedEffects.includes("run.abort")
      ? [{ type: "run.abort", reason } as const]
      : []),
    {
      type: "audit.annotate",
      annotation: `${pointId}: ${reason}`,
      severity: "error",
    },
  ];
}

/**
 * Contract failure at a point. Pre-boundary points default fail-closed and
 * deny; post-boundary points default fail-open, so a missing or malformed
 * context there composes to an ALLOW carrying only audit evidence —
 * enforcement degrades to observation. That fail-open-by-omission is a
 * documented, tested design decision, not an oversight.
 */
export function pointContractDecision(
  pointId: PolicyPointId,
  reason: "policy.context_missing" | "policy.input_invalid",
): Policy.PolicyDecision {
  const contract = Policy.PolicyPoint.Registry[pointId];
  const options = {
    policyId: ENFORCEMENT_POLICY_ID,
    reasonCodes: [reason],
    effects: enforcementEffects(pointId, reason),
  };
  return contract.defaultFailPolicy === "fail-closed"
    ? PolicyDecision.deny(options)
    : PolicyDecision.allow(options);
}

export function undeclaredEffectDecision(
  reg: RegistrationMeta,
  pointId: PolicyPointId,
  effectType: Policy.PolicyEffectType,
  durationMs: number,
): Policy.PolicyDecision {
  const reason = "policy.effect_not_declared";
  return PolicyDecision.deny({
    policyId: reg.name,
    reasonCodes: [reason],
    durationMs,
    priority: reg.priority,
    effects: enforcementEffects(pointId, `${reason}: ${effectType}`),
  });
}

/** Reason-code prefix for a fail-open middleware crash; suffixed with the registration name. */
export const MIDDLEWARE_FAIL_OPEN_REASON = "policy.middleware_failed.fail_open";

/**
 * A fail-open middleware threw. Fail-open semantics stand — the policy
 * contributes no verdict — but the crash must leave evidence in the composed
 * decision itself, not only in the optional telemetry seam: the reason code
 * names the skipped policy and an audit annotation rides the merged effects,
 * so an allow produced past a crashed guard is distinguishable from a clean
 * one even when no `auditEmit` is bound.
 */
export function pointMiddlewareFailOpenDecision(
  reg: RegistrationMeta,
  pointId: PolicyPointId,
  durationMs: number,
): Policy.PolicyDecision {
  const reason = `${MIDDLEWARE_FAIL_OPEN_REASON}:${reg.name}`;
  return PolicyDecision.allow({
    policyId: reg.name,
    reasonCodes: [reason],
    durationMs,
    priority: reg.priority,
    effects: [
      {
        type: "audit.annotate",
        annotation: `${pointId}: ${reason}`,
        severity: "warning",
      },
    ],
  });
}

export function pointMiddlewareErrorDecision(
  reg: RegistrationMeta,
  pointId: PolicyPointId,
  durationMs: number,
): Policy.PolicyDecision {
  const reason = "middleware-error";
  return PolicyDecision.deny({
    policyId: reg.name,
    reasonCodes: [reason],
    durationMs,
    priority: reg.priority,
    effects: enforcementEffects(pointId, reason),
  });
}

export function normalizePointDecision(
  decision: unknown,
  reg: RegistrationMeta,
  pointId: PolicyPointId,
  durationMs: number,
): {
  readonly decision: Policy.PolicyDecision;
  readonly parsed?: Policy.PolicyDecision;
} {
  const invalidDecision = () => {
    const reason = "policy.invalid_decision";
    return {
      decision: PolicyDecision.deny({
        policyId: reg.name,
        reasonCodes: [reason],
        durationMs,
        priority: reg.priority,
        effects: enforcementEffects(pointId, reason),
      }),
    };
  };

  let parsed: ReturnType<typeof Policy.PolicyDecision.safeParse>;
  try {
    parsed = Policy.PolicyDecision.safeParse(decision);
  } catch {
    return invalidDecision();
  }
  if (!parsed.success) return invalidDecision();
  // The middleware's identity fields are overridden with what the engine
  // knows first-hand: it invoked THIS registration, and it measured the
  // duration itself. `policyId` in particular is a trust boundary — conflict
  // detection exempts same-policyId writes and audit attributes decisions by
  // it, so a decision returning another policy's id could evade fail-closed
  // conflicts and spoof PolicyEvent.Evaluated attribution.
  return {
    decision: { ...parsed.data, policyId: reg.name, durationMs, priority: reg.priority },
    parsed: parsed.data,
  };
}
