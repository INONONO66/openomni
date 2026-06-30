import { Operational, type Policy, PolicyDecision } from "@openomni/protocol";
import {
  COMPOSED_POLICY_ID,
  composeFinalDecision,
  middlewareErrorDecision,
  normalizeDecision,
} from "./engine-decisions";
import { defaultFailPolicy } from "./engine-points";
import { selectRegistrations } from "./engine-selection";
import { immutableSnapshot } from "./engine-snapshot";
import {
  publishComposedDecision,
  publishDecisionObserverError,
  publishPolicyEvent,
} from "./engine-audit";
import type {
  AuditDispatchContextGeneric,
  DispatchContextGeneric,
  GenericPolicyContext,
  PolicyAuditConfig,
  PolicyEngineConfig,
  PolicyEngineInstanceGeneric,
  PolicyRegistrationGeneric,
} from "./engine-types";
export type {
  PolicyAuditConfig,
  PolicyDecision,
  PolicyEngineConfig,
  GenericPolicyContext,
  PolicyRegistrationGeneric,
  PolicyEngineInstanceGeneric,
  DispatchContextGeneric,
  AuditDispatchContextGeneric,
} from "./engine-types";

function recordDecision(
  options: PolicyEngineConfig,
  reg: { name: string },
  ctx: AuditDispatchContextGeneric<GenericPolicyContext>,
  decision: Policy.PolicyDecision,
): Policy.PolicyDecision {
  publishPolicyEvent(options, decision, reg, ctx);
  try {
    void Promise.resolve(options.onDecision?.(decision)).catch((err) => {
      publishDecisionObserverError(options, ctx, decision, err);
    });
  } catch (err) {
    publishDecisionObserverError(options, ctx, decision, err);
  }
  return decision;
}

function publishMiddlewareError(
  options: PolicyEngineConfig,
  timing: Policy.Timing,
  name: string,
  err: unknown,
  failPolicy: Policy.FailPolicy,
  durationMs: number,
): void {
  options.auditEmit?.(Operational.Warn, {
    traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
    time: Date.now(),
    component: "agent.policy",
    msg: "middleware error",
    context: { timing, name, error: String(err), failPolicy, durationMs },
  });
}

function publishMiddlewareDebug(
  options: PolicyEngineConfig,
  timing: Policy.Timing,
  name: string,
  verdict: Policy.PolicyDecision["verdict"],
  durationMs: number,
): void {
  options.auditEmit?.(Operational.Debug, {
    traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
    time: Date.now(),
    component: "agent.policy",
    msg: "middleware dispatch",
    context: { timing, name, verdict, durationMs },
  });
}

function create<TCtx extends GenericPolicyContext>(
  options: PolicyEngineConfig = {},
): PolicyEngineInstanceGeneric<TCtx> {
  const registrations: PolicyRegistrationGeneric<TCtx>[] = [];

  async function dispatch(
    timing: Policy.Timing,
    ctx: DispatchContextGeneric<TCtx> & Record<string, unknown>,
  ): Promise<Policy.PolicyDecision> {
    const selected = selectRegistrations(registrations, timing, ctx.agentType);
    const fullCtx: AuditDispatchContextGeneric<TCtx> = immutableSnapshot({
      ...ctx,
      timing,
    } as AuditDispatchContextGeneric<TCtx>);
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
        publishMiddlewareError(options, timing, reg.name, err, failPolicy, durationMs);
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

  return {
    register(reg) {
      registrations.push(reg);
    },
    dispatch,
  };
}

export const PolicyEngine = { create };
