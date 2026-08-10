import { Policy, PolicyDecision } from "@openomni/protocol";
import { COMPOSED_POLICY_ID, composeFinalPointDecision } from "./decisions";
import { timingForPolicyPoint } from "./points";
import { createPolicyRegistrationStore } from "./registration";
import { immutablePointSnapshot } from "./context";
import { publishComposedDecision } from "./audit";
import { publishMiddlewareDebug, publishMiddlewareError, recordDecision } from "./telemetry";
import {
  normalizePointDecision,
  pointContractDecision,
  pointMiddlewareErrorDecision,
  undeclaredEffectDecision,
} from "./point-decisions";
import type {
  CanonicalPolicyRegistrationGeneric,
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

  async function dispatchPoint<TPointId extends PolicyPointId>(
    pointId: TPointId,
    ctx: DispatchPointContextGeneric<TCtx, TPointId>,
  ): Promise<Policy.PolicyDecision> {
    const timing = timingForPolicyPoint(pointId);
    const snapshot = immutablePointSnapshot(ctx, { pointId, timing });
    const auditCtx = snapshot.success
      ? snapshot.value
      : invalidPointAuditContext(ctx, pointId, timing);
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

    const selected = registrations.selectPoint(pointId, fullCtx.agentType);
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
    reg: CanonicalPolicyRegistrationGeneric<TCtx>,
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
    const declaredEffects = reg.effectCapabilities[pointId] ?? [];
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
    dispatchPoint,
  };
}

const SAFE_INVALID_CONTEXT_AUDIT_KEYS = [
  "traceContext",
  "sessionId",
  "runId",
  "resourceDescriptor",
  "toolName",
  "dispatchId",
  "correlation",
] as const;

function invalidPointAuditContext(
  ctx: object,
  pointId: PolicyPointId,
  timing: Policy.Timing,
): Readonly<
  Record<string, unknown> & { readonly pointId: PolicyPointId; readonly timing: Policy.Timing }
> {
  const safeFields: Record<string, unknown> = {};
  for (const key of SAFE_INVALID_CONTEXT_AUDIT_KEYS) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(ctx, key);
      if (descriptor === undefined || !("value" in descriptor)) continue;
      const captured = immutablePointSnapshot({ [key]: descriptor.value }, {});
      if (captured.success) Object.assign(safeFields, captured.value);
    } catch {
      // Ignore unsafe getters/proxies while retaining independently safe correlation fields.
    }
  }
  return Object.freeze({ ...safeFields, pointId, timing });
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
