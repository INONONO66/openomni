import { Policy, PolicyDecision, type RuntimeResource } from "@openomni/protocol";
import { composeEffects } from "./effect-composition";
import { allowedEffectTypes, isPreBoundary, policyPointIdsForDescriptor } from "./engine-points";

export const COMPOSED_POLICY_ID = "agent.policy.composed";

const EFFECT_VALIDATION_REASON = "policy.effect_not_allowed";
const MIDDLEWARE_ERROR_REASON = "middleware-error";

type RegistrationMeta = { name: string; priority: number };

function totalDurationMs(decisions: readonly Policy.PolicyDecision[]): number {
  return decisions.reduce((total, decision) => total + (decision.durationMs ?? 0), 0);
}

function validationFailure(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
  effects: readonly Policy.PolicyEffect[],
): Policy.PolicyDecision | undefined {
  const allowed = allowedEffectTypes(timing, descriptor);
  const invalid = effects.find((effect) => !allowed.has(effect.type));
  if (!invalid) return undefined;

  const pointId = policyPointIdsForDescriptor(timing, descriptor)[0];
  const annotation =
    pointId === undefined
      ? `${EFFECT_VALIDATION_REASON}: ${invalid.type} is not allowed at ${timing}`
      : `${EFFECT_VALIDATION_REASON}: ${invalid.type} is not allowed at ${pointId}`;

  return PolicyDecision.deny({
    policyId: COMPOSED_POLICY_ID,
    effects: [{ type: "audit.annotate", annotation, severity: "error" }],
    reasonCodes: [EFFECT_VALIDATION_REASON],
  });
}

function enforceDenyAbort(
  decision: Policy.PolicyDecision,
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.PolicyDecision {
  if (decision.verdict !== "deny") return decision;
  if (decision.effects.some((effect) => effect.type === "run.abort")) return decision;
  if (!isPreBoundary(timing, descriptor)) return decision;
  if (!allowedEffectTypes(timing, descriptor).has("run.abort")) return decision;

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
    effective.verdict === "deny"
      ? decisions.filter((decision) => decision.verdict === "deny")
      : effective.verdict === "pending"
        ? decisions.filter((decision) => decision.verdict === "pending")
        : decisions;
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

export function composeFinalDecision(
  decisions: readonly Policy.PolicyDecision[],
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.PolicyDecision {
  const effective = composeEffects([...decisions]);
  const decision =
    validationFailure(timing, descriptor, effective.mergedEffects) ??
    composedDecision(effective, decisions);
  return enforceDenyAbort(decision, timing, descriptor);
}

export function middlewareErrorDecision(
  reg: RegistrationMeta,
  durationMs: number,
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.PolicyDecision {
  const effects: Policy.PolicyEffect[] = [
    {
      type: "audit.annotate",
      annotation: `${reg.name}: ${MIDDLEWARE_ERROR_REASON}`,
      severity: "error",
    },
  ];
  if (allowedEffectTypes(timing, descriptor).has("run.abort")) {
    effects.unshift({ type: "run.abort", reason: MIDDLEWARE_ERROR_REASON });
  }

  return PolicyDecision.deny({
    policyId: reg.name,
    reasonCodes: [MIDDLEWARE_ERROR_REASON],
    durationMs,
    priority: reg.priority,
    effects,
  });
}

function invalidDecision(
  reg: RegistrationMeta,
  durationMs: number,
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.PolicyDecision {
  const reason = "policy.invalid_decision";
  const effects: Policy.PolicyEffect[] = [
    {
      type: "audit.annotate",
      annotation: `${reg.name}: ${reason}`,
      severity: "error",
    },
  ];
  if (allowedEffectTypes(timing, descriptor).has("run.abort")) {
    effects.unshift({ type: "run.abort", reason });
  }

  return PolicyDecision.deny({
    policyId: reg.name,
    reasonCodes: [reason],
    durationMs,
    priority: reg.priority,
    effects,
  });
}

export function normalizeDecision(
  decision: unknown,
  reg: RegistrationMeta,
  durationMs: number,
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.PolicyDecision {
  const parsed = Policy.PolicyDecision.safeParse(decision);
  if (!parsed.success) return invalidDecision(reg, durationMs, timing, descriptor);

  return {
    ...parsed.data,
    durationMs,
    priority: reg.priority,
  };
}
