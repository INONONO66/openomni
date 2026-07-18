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
  return {
    decision: { ...parsed.data, durationMs, priority: reg.priority },
    parsed: parsed.data,
  };
}
