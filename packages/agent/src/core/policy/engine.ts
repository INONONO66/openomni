import { Operational, type Policy, PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/session";
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
  AuditDispatchContext,
  DispatchContext,
  PolicyEngineConfig,
  PolicyEngineInstance,
} from "./engine-types";
import type { PolicyRegistration } from "./types";

export type {
  DispatchContext,
  PolicyAuditConfig,
  PolicyDecision,
  PolicyEngineConfig,
  PolicyEngineInstance,
} from "./engine-types";

function recordDecision(
  options: PolicyEngineConfig,
  reg: PolicyRegistration,
  ctx: AuditDispatchContext,
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
  Bus.publish(Operational.Warn, {
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
  Bus.publish(Operational.Debug, {
    traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
    time: Date.now(),
    component: "agent.policy",
    msg: "middleware dispatch",
    context: { timing, name, verdict, durationMs },
  });
}

function create(options: PolicyEngineConfig = {}): PolicyEngineInstance {
  const registrations: PolicyRegistration[] = [];

  async function dispatch(
    timing: Policy.Timing,
    ctx: DispatchContext,
  ): Promise<Policy.PolicyDecision> {
    const selected = selectRegistrations(registrations, timing, ctx.agentType);
    const fullCtx: AuditDispatchContext = immutableSnapshot({ ...ctx, timing });
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
