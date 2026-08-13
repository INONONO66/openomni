import { Operational, type Policy } from "@openomni/protocol";
import { publishDecisionObserverError, publishPolicyEvent } from "./audit";
import type {
  AuditDispatchContextGeneric,
  GenericPolicyContext,
  PolicyEngineConfig,
} from "./types";

export function recordDecision(
  options: PolicyEngineConfig,
  reg: { readonly name: string },
  ctx: Readonly<AuditDispatchContextGeneric<GenericPolicyContext>>,
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

export function publishMiddlewareError(
  options: PolicyEngineConfig,
  timing: Policy.Timing,
  name: string,
  err: unknown,
  failPolicy: Policy.FailPolicy,
  durationMs: number,
): void {
  const traceId = options.traceContext?.traceId;
  if (traceId === undefined) return;
  options.auditEmit?.(Operational.Warn, {
    traceId,
    time: Date.now(),
    component: "agent.policy",
    msg: "middleware error",
    context: { timing, name, error: String(err), failPolicy, durationMs },
  });
}

export function publishMiddlewareDebug(
  options: PolicyEngineConfig,
  timing: Policy.Timing,
  name: string,
  verdict: Policy.PolicyDecision["verdict"],
  durationMs: number,
): void {
  const traceId = options.traceContext?.traceId;
  if (traceId === undefined) return;
  options.auditEmit?.(Operational.Debug, {
    traceId,
    time: Date.now(),
    component: "agent.policy",
    msg: "middleware dispatch",
    context: { timing, name, verdict, durationMs },
  });
}
