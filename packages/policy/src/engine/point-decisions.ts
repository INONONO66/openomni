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
 * context there composes to an ALLOW carrying only audit evidence.
 *
 * This preserves the #806 post-boundary decision. Its containment boundary is
 * exact: validation returns before any middleware runs, and
 * `enforcementEffects` cannot add `run.abort` after the side-effect boundary.
 * A malformed post context can therefore leak neither middleware effects nor
 * a late abort; only the contract reason and audit annotation survive.
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

const MIDDLEWARE_FAIL_OPEN_REASON = "policy.middleware_failed.fail_open";

/**
 * A fail-open middleware threw. The #806 continuation decision stands: the
 * policy contributes no verdict and later middleware still run. The
 * containment boundary is the throw itself: no decision was returned, so no
 * effect or identity field from the crashed policy can enter composition, and
 * a post-boundary point cannot gain `run.abort`. Only this engine-authored
 * reason and audit annotation survive, making the degraded allow visible even
 * without `auditEmit`.
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
  // conflicts and spoof Policy.Events.Evaluated attribution.
  return {
    decision: { ...parsed.data, policyId: reg.name, durationMs, priority: reg.priority },
    parsed: parsed.data,
  };
}
