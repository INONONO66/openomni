import { Policy, PolicyDecision } from "@openomni/protocol";
import {
  COMPOSED_POLICY_ID,
  composeFinalDecision,
  composeFinalPointDecision,
  middlewareErrorDecision,
  normalizeDecision,
} from "./decisions";
import { defaultFailPolicy, timingForPolicyPoint } from "./points";
import { createPolicyRegistrationStore } from "./registration";
import { immutablePointSnapshot, immutableSnapshot } from "./context";
import { publishComposedDecision } from "./audit";
import { publishMiddlewareDebug, publishMiddlewareError, recordDecision } from "./telemetry";
import {
  normalizePointDecision,
  pointContractDecision,
  pointMiddlewareErrorDecision,
  undeclaredEffectDecision,
} from "./point-decisions";
import type {
  DispatchContextGeneric,
  DispatchPointContextGeneric,
  GenericPolicyContext,
  PolicyEngineConfig,
  PolicyEngineCompatibilityGeneric,
  PolicyEngineRegistrationGeneric,
  PolicyEngineInstanceGeneric,
  PolicyPointId,
} from "./types";

export function createPolicyEngine<TCtx extends GenericPolicyContext>(
  options: PolicyEngineConfig = {},
  compatibility: PolicyEngineCompatibilityGeneric<TCtx> = {},
): PolicyEngineInstanceGeneric<TCtx> {
  const registrations = createPolicyRegistrationStore<TCtx>();

  async function dispatch(
    timing: Policy.Timing,
    ctx: DispatchContextGeneric<TCtx> & Record<string, unknown>,
  ): Promise<Policy.PolicyDecision> {
    const fullCtx = immutableSnapshot({
      ...ctx,
      timing,
    });
    const pointId = compatibility.resolvePointForLegacyDispatch?.(timing, fullCtx);
    const pointSnapshot =
      pointId === undefined
        ? undefined
        : immutablePointSnapshot<TCtx>(fullCtx, { pointId, timing });
    const auditCtx = pointId === undefined ? fullCtx : Object.freeze({ ...fullCtx, pointId });
    let canonicalContractFailure: Policy.PolicyDecision | undefined;
    if (pointId !== undefined && pointSnapshot !== undefined) {
      canonicalContractFailure = pointSnapshot.success
        ? validatePointContract(pointId, pointSnapshot.value)
        : pointContractDecision(pointId, "policy.input_invalid");
    }
    const selected =
      pointId === undefined
        ? registrations.selectLegacy(timing, fullCtx.agentType)
        : registrations.selectLegacyCompatible(timing, fullCtx.agentType, pointId);
    const decisions: Policy.PolicyDecision[] = [];
    let canonicalContractRecorded = false;

    function composeAndPublish(): Policy.PolicyDecision {
      const decision = composeFinalDecision(decisions, timing, ctx.resourceDescriptor);
      publishComposedDecision(options, timing, auditCtx, decision);
      return decision;
    }

    if (selected.length === 0) {
      if (canonicalContractFailure !== undefined) {
        decisions.push(
          recordDecision(
            options,
            { name: "policy.point.contract" },
            auditCtx,
            canonicalContractFailure,
          ),
        );
        return composeAndPublish();
      }
      const decision = PolicyDecision.allow({ policyId: COMPOSED_POLICY_ID });
      publishComposedDecision(options, timing, auditCtx, decision);
      return decision;
    }

    for (const reg of selected) {
      const startTime = Date.now();
      let decision: Policy.PolicyDecision | undefined;
      const isCanonical = "kind" in reg;
      if (isCanonical) {
        if (pointId === undefined || pointSnapshot === undefined) continue;
        if (canonicalContractFailure !== undefined) {
          if (canonicalContractRecorded) continue;
          canonicalContractRecorded = true;
          decision = canonicalContractFailure;
        } else if (pointSnapshot.success) {
          decision = await evaluateCanonical(reg, pointId, () => reg.fn(pointSnapshot.value));
        } else {
          continue;
        }
      } else {
        try {
          decision = await reg.fn(fullCtx);
        } catch (err) {
          const durationMs = Date.now() - startTime;
          const failPolicy = reg.failPolicy ?? defaultFailPolicy(timing, ctx.resourceDescriptor);
          const error = err instanceof Error ? err : new Error(String(err));
          publishMiddlewareError(options, timing, reg.name, error, failPolicy, durationMs);
          if (failPolicy === "fail-open") continue;

          decision = middlewareErrorDecision(reg, durationMs, timing, ctx.resourceDescriptor);
        }
      }

      if (decision === undefined) continue;

      const durationMs = Date.now() - startTime;
      const normalized = isCanonical
        ? decision
        : normalizeDecision(decision, reg, durationMs, timing, ctx.resourceDescriptor);
      const auditRegistration =
        normalized.policyId === "policy.point.contract" ? { name: "policy.point.contract" } : reg;
      decisions.push(recordDecision(options, auditRegistration, auditCtx, normalized));
      if (!isCanonical) {
        publishMiddlewareDebug(options, timing, reg.name, normalized.verdict, durationMs);
      }

      if (normalized.verdict === "deny") return composeAndPublish();
    }

    return composeAndPublish();
  }

  async function dispatchPoint<TPointId extends PolicyPointId>(
    pointId: TPointId,
    ctx: DispatchPointContextGeneric<TCtx, TPointId>,
  ): Promise<Policy.PolicyDecision> {
    const timing = timingForPolicyPoint(pointId);
    const snapshot = immutablePointSnapshot(ctx, { pointId, timing });
    const auditCtx = snapshot.success ? snapshot.value : Object.freeze({ pointId, timing });
    const decisions: Policy.PolicyDecision[] = [];

    function composeAndPublish(): Policy.PolicyDecision {
      const decision = composeFinalPointDecision(decisions, pointId);
      publishComposedDecision(options, timing, auditCtx, decision);
      return decision;
    }

    if (!snapshot.success) {
      decisions.push(
        recordDecision(
          options,
          { name: "policy.point.contract" },
          auditCtx,
          pointContractDecision(pointId, "policy.input_invalid"),
        ),
      );
      return composeAndPublish();
    }
    const fullCtx = snapshot.value;

    const contractFailure = validatePointContract(pointId, fullCtx);
    if (contractFailure !== undefined) {
      decisions.push(
        recordDecision(options, { name: "policy.point.contract" }, fullCtx, contractFailure),
      );
      return composeAndPublish();
    }

    const selected = compatibility.includeLegacyAtPoint
      ? registrations.selectPointCompatible(pointId, fullCtx.agentType)
      : registrations.selectPoint(pointId, fullCtx.agentType);
    if (selected.length === 0) {
      const decision = PolicyDecision.allow({ policyId: COMPOSED_POLICY_ID });
      publishComposedDecision(options, timing, fullCtx, decision);
      return decision;
    }

    for (const reg of selected) {
      const enforced = await evaluateCanonical(reg, pointId, () => reg.fn(fullCtx));
      if (enforced === undefined) continue;
      decisions.push(recordDecision(options, reg, fullCtx, enforced));

      if (enforced.verdict === "deny") return composeAndPublish();
    }

    return composeAndPublish();
  }

  async function evaluateCanonical(
    reg: PolicyEngineRegistrationGeneric<TCtx>,
    pointId: PolicyPointId,
    invoke: () => Promise<Policy.PolicyDecision> | Policy.PolicyDecision,
  ): Promise<Policy.PolicyDecision | undefined> {
    const contract = Policy.PolicyPoint.Registry[pointId];
    const timing = timingForPolicyPoint(pointId);
    const startTime = Date.now();
    let middlewareDecision: unknown;
    let engineDecision: Policy.PolicyDecision | undefined;
    try {
      middlewareDecision = await invoke();
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const failPolicy = reg.failPolicy ?? contract.defaultFailPolicy;
      const error = err instanceof Error ? err : new Error(String(err));
      publishMiddlewareError(options, timing, reg.name, error, failPolicy, durationMs);
      if (failPolicy === "fail-open") return undefined;
      engineDecision = pointMiddlewareErrorDecision(reg, pointId, durationMs);
    }

    const durationMs = Date.now() - startTime;
    const normalized =
      engineDecision === undefined
        ? normalizePointDecision(middlewareDecision, reg, pointId, durationMs)
        : { decision: engineDecision };
    const declaredEffects = declaredEffectsFor(reg, pointId, contract.allowedEffects);
    const undeclared = normalized.parsed?.effects.find(
      (effect) => !declaredEffects.includes(effect.type),
    );
    const enforced =
      undeclared === undefined
        ? normalized.decision
        : undeclaredEffectDecision(reg, pointId, undeclared.type, durationMs);
    publishMiddlewareDebug(options, timing, reg.name, enforced.verdict, durationMs);
    return enforced;
  }

  return {
    register(reg) {
      registrations.register(reg);
    },
    dispatch,
    dispatchPoint,
  };
}

function validatePointContract(
  pointId: PolicyPointId,
  fullCtx: Readonly<object>,
): Policy.PolicyDecision | undefined {
  const contract = Policy.PolicyPoint.Registry[pointId];
  if (contract.requiredContext.some((key) => Reflect.get(fullCtx, key) === undefined)) {
    return pointContractDecision(pointId, "policy.context_missing");
  }
  if (!Policy.PolicyPoint.InputSchemas[pointId].safeParse(fullCtx).success) {
    return pointContractDecision(pointId, "policy.input_invalid");
  }
  return undefined;
}

function declaredEffectsFor<TCtx extends GenericPolicyContext>(
  registration: PolicyEngineRegistrationGeneric<TCtx>,
  pointId: PolicyPointId,
  legacyEffects: readonly Policy.PolicyEffectType[],
): readonly Policy.PolicyEffectType[] {
  return "kind" in registration ? (registration.effectCapabilities[pointId] ?? []) : legacyEffects;
}
