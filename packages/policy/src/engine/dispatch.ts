import { Policy, PolicyDecision, type TraceContext } from "@openomni/protocol";
import { auditIsConsumed, publishComposedDecision } from "./audit";
import { auditCorrelationContext, immutablePointSnapshot } from "./context";
import { COMPOSED_POLICY_ID, composeFinalPointDecision } from "./decisions";
import {
  normalizePointDecision,
  pointContractDecision,
  pointMiddlewareErrorDecision,
  undeclaredEffectDecision,
} from "./point-decisions";
import { timingForPolicyPoint } from "./points";
import { createPolicyRegistrationStore } from "./registration";
import { publishMiddlewareDebug, publishMiddlewareError, recordDecision } from "./telemetry";
import type {
  CanonicalPolicyRegistrationGeneric,
  DispatchPointContextGeneric,
  GenericPolicyContext,
  PolicyEngineConfig,
  PolicyEngineInstanceGeneric,
  PolicyPointId,
} from "./types";

const CONTRACT_REGISTRATION = { name: "policy.point.contract" } as const;

export function createPolicyEngine<TCtx extends GenericPolicyContext>(
  options: PolicyEngineConfig = {},
): PolicyEngineInstanceGeneric<TCtx> {
  const registrations = createPolicyRegistrationStore<TCtx>();

  /**
   * A point with no registration is unguarded: nothing will read the context,
   * so it is never cloned or frozen. The point contract still runs, against the
   * caller's object — snapshot-ability is a precondition for handing a context
   * to a policy, and here no policy exists to hand it to.
   */
  function dispatchUnguardedPoint(
    pointId: PolicyPointId,
    ctx: object,
    timing: Policy.Timing,
  ): Policy.PolicyDecision {
    const contractFailure = validatePointContract(pointId, ctx);
    // Skipped when nothing reads it — the completion-admission engine binds
    // neither `auditEmit` nor `onDecision`, and `work.complete.pre` is
    // permanently unguarded, so this is its whole per-dispatch cost.
    const auditCtx =
      auditIsConsumed(options) || options.onDecision !== undefined
        ? auditCorrelationContext(ctx, pointId, timing)
        : Object.freeze({ pointId, timing });
    const decision =
      contractFailure === undefined
        ? PolicyDecision.allow({ policyId: COMPOSED_POLICY_ID })
        : composeFinalPointDecision(
            [recordDecision(options, CONTRACT_REGISTRATION, auditCtx, contractFailure)],
            pointId,
          );
    publishComposedDecision(options, timing, auditCtx, decision);
    return decision;
  }

  async function dispatchPoint<TPointId extends PolicyPointId>(
    pointId: TPointId,
    ctx: DispatchPointContextGeneric<TCtx, TPointId>,
  ): Promise<Policy.PolicyDecision> {
    const timing = timingForPolicyPoint(pointId);
    // Selection reads the agent type once and pins it into the snapshot below,
    // so a context getter cannot answer the selector and the policy differently.
    const agentType = readAgentType(ctx);
    const selected = registrations.selectPoint(pointId, agentType);
    if (selected.length === 0) return dispatchUnguardedPoint(pointId, ctx, timing);

    const snapshot = immutablePointSnapshot(ctx, {
      pointId,
      timing,
      ...(agentType === undefined ? {} : { agentType }),
    });
    const auditCtx = snapshot.success
      ? snapshot.value
      : auditCorrelationContext(ctx, pointId, timing);
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
          CONTRACT_REGISTRATION,
          auditCtx,
          pointContractDecision(pointId, "policy.input_invalid"),
        ),
      );
      return composeAndPublish();
    }
    const fullCtx = snapshot.value;
    // The trace of this dispatch. Read off the frozen snapshot so a context
    // getter cannot answer the policy and the audit record differently.
    const dispatchTrace = (fullCtx as { readonly traceContext?: TraceContext.Type }).traceContext;

    const contractFailure = validatePointContract(pointId, fullCtx);
    if (contractFailure !== undefined) {
      decisions.push(recordDecision(options, CONTRACT_REGISTRATION, fullCtx, contractFailure));
      return composeAndPublish();
    }

    for (const reg of selected) {
      const enforced = await evaluateCanonical(reg, pointId, dispatchTrace, () => reg.fn(fullCtx));
      if (enforced === undefined) continue;
      decisions.push(recordDecision(options, reg, fullCtx, enforced));

      if (enforced.verdict === "deny") return composeAndPublish();
    }

    return composeAndPublish();
  }

  async function evaluateCanonical(
    reg: CanonicalPolicyRegistrationGeneric<TCtx>,
    pointId: PolicyPointId,
    dispatchTrace: TraceContext.Type | undefined,
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
      publishMiddlewareError(
        options,
        dispatchTrace,
        timing,
        reg.name,
        error,
        failPolicy,
        durationMs,
      );
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
    publishMiddlewareDebug(options, dispatchTrace, timing, reg.name, enforced.verdict, durationMs);
    return enforced;
  }

  return {
    register(reg) {
      // Factories are unwrapped inside the registration boundary
      // (`prepareRegistrationBoundary`), once per engine: the engine is built
      // per run, so the instantiation is what scopes a stateful policy's
      // closure state to the run (see PolicyRegistrationFactoryGeneric).
      registrations.register(reg);
    },
    dispatchPoint,
  };
}

function readAgentType(ctx: object): string | undefined {
  try {
    const agentType = Reflect.get(ctx, "agentType");
    return typeof agentType === "string" ? agentType : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Total by construction. On the unguarded path this reads the caller's own
 * object — `Reflect.get` for the required keys, and a `.passthrough()` schema
 * that walks every key — so a hostile accessor would otherwise escape
 * `dispatchPoint` as an exception rather than a verdict. Every caller awaits a
 * decision; a throw would bypass fail-closed and fail-open alike.
 */
function validatePointContract(
  pointId: PolicyPointId,
  ctx: Readonly<object>,
): Policy.PolicyDecision | undefined {
  const contract = Policy.PolicyPoint.Registry[pointId];
  try {
    if (contract.requiredContext.some((key) => Reflect.get(ctx, key) === undefined)) {
      return pointContractDecision(pointId, "policy.context_missing");
    }
    if (!Policy.PolicyPoint.InputSchemas[pointId].safeParse(ctx).success) {
      return pointContractDecision(pointId, "policy.input_invalid");
    }
    return undefined;
  } catch {
    // Matches the snapshot path, where the same throw is absorbed by
    // `immutablePointSnapshot` and reported as an invalid input.
    return pointContractDecision(pointId, "policy.input_invalid");
  }
}
