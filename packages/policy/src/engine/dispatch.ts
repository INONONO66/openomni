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
  PolicyEngineInstanceGeneric,
  PolicyPointId,
} from "./types";

export function createPolicyEngine<TCtx extends GenericPolicyContext>(
  options: PolicyEngineConfig = {},
): PolicyEngineInstanceGeneric<TCtx> {
  const registrations = createPolicyRegistrationStore<TCtx>();

  async function dispatch(
    timing: Policy.Timing,
    ctx: DispatchContextGeneric<TCtx> & Record<string, unknown>,
  ): Promise<Policy.PolicyDecision> {
    const selected = registrations.selectLegacy(timing, ctx.agentType);
    const fullCtx = immutableSnapshot({
      ...ctx,
      timing,
    });
    const decisions: Policy.PolicyDecision[] = [];

    function composeAndPublish(): Policy.PolicyDecision {
      const decision = composeFinalDecision(decisions, timing, ctx.resourceDescriptor);
      publishComposedDecision(options, timing, fullCtx, decision);
      return decision;
    }

    if (selected.length === 0) {
      const decision = PolicyDecision.allow({ policyId: COMPOSED_POLICY_ID });
      publishComposedDecision(options, timing, fullCtx, decision);
      return decision;
    }

    for (const reg of selected) {
      let decision: Policy.PolicyDecision;
      const startTime = Date.now();
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

      const durationMs = Date.now() - startTime;
      const normalized = normalizeDecision(
        decision,
        reg,
        durationMs,
        timing,
        ctx.resourceDescriptor,
      );
      decisions.push(recordDecision(options, reg, fullCtx, normalized));
      publishMiddlewareDebug(options, timing, reg.name, normalized.verdict, durationMs);

      if (normalized.verdict === "deny") return composeAndPublish();
    }

    return composeAndPublish();
  }

  async function dispatchPoint<TPointId extends PolicyPointId>(
    pointId: TPointId,
    ctx: DispatchPointContextGeneric<TCtx, TPointId>,
  ): Promise<Policy.PolicyDecision> {
    const contract = Policy.PolicyPoint.Registry[pointId];
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

    const missingContext = contract.requiredContext.some(
      (key) => Reflect.get(fullCtx, key) === undefined,
    );
    let contractFailure: Policy.PolicyDecision | undefined;
    if (missingContext) {
      contractFailure = pointContractDecision(pointId, "policy.context_missing");
    } else if (!Policy.PolicyPoint.InputSchemas[pointId].safeParse(fullCtx).success) {
      contractFailure = pointContractDecision(pointId, "policy.input_invalid");
    }
    if (contractFailure !== undefined) {
      decisions.push(
        recordDecision(options, { name: "policy.point.contract" }, fullCtx, contractFailure),
      );
      return composeAndPublish();
    }

    const selected = registrations.selectPoint(pointId, fullCtx.agentType);
    if (selected.length === 0) {
      const decision = PolicyDecision.allow({ policyId: COMPOSED_POLICY_ID });
      publishComposedDecision(options, timing, fullCtx, decision);
      return decision;
    }

    for (const reg of selected) {
      const startTime = Date.now();
      let middlewareDecision: unknown;
      let engineDecision: Policy.PolicyDecision | undefined;
      try {
        middlewareDecision = await reg.fn(fullCtx);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const failPolicy = reg.failPolicy ?? contract.defaultFailPolicy;
        const error = err instanceof Error ? err : new Error(String(err));
        publishMiddlewareError(options, timing, reg.name, error, failPolicy, durationMs);
        if (failPolicy === "fail-open") continue;
        engineDecision = pointMiddlewareErrorDecision(reg, pointId, durationMs);
      }

      const durationMs = Date.now() - startTime;
      const normalized =
        engineDecision === undefined
          ? normalizePointDecision(middlewareDecision, reg, pointId, durationMs)
          : { decision: engineDecision };
      const declaredEffects = reg.effectCapabilities[pointId] ?? [];
      const undeclared = normalized.parsed?.effects.find(
        (effect) => !declaredEffects.some((declared) => declared === effect.type),
      );
      const enforced =
        undeclared === undefined
          ? normalized.decision
          : undeclaredEffectDecision(reg, pointId, undeclared.type, durationMs);
      decisions.push(recordDecision(options, reg, fullCtx, enforced));
      publishMiddlewareDebug(options, timing, reg.name, enforced.verdict, durationMs);

      if (enforced.verdict === "deny") return composeAndPublish();
    }

    return composeAndPublish();
  }

  return {
    register(reg) {
      registrations.register(reg);
    },
    dispatch,
    dispatchPoint,
  };
}
