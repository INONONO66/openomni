import { Operational, type Policy, type TraceContext } from "@openomni/protocol";
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

/** An empty trace id names nothing; every guard in the tree treats it as absent. */
function nonEmptyTraceId(trace: TraceContext.Type | undefined): string | undefined {
  const traceId = trace?.traceId;
  return traceId !== undefined && traceId.length > 0 ? traceId : undefined;
}

/**
 * A middleware threw. Reported under the dispatch's trace, or the engine's,
 * or not at all.
 *
 * The silence is the ruling, not an oversight: an error record filed under a
 * minted trace names a run that does not exist, and a reader chasing it finds
 * nothing — worse than no record, because it looks like evidence.
 *
 * A fail-closed middleware still denies, so its failure reaches the caller
 * through the verdict. A fail-open one does not: `dispatch.ts` drops its
 * decision, so with no trace to report under, the throw leaves no trace at
 * all. That is the cost, and it is bounded to an engine that was never told
 * its trace — a wiring choice at `PolicyEngine.create`, not a runtime
 * accident.
 */
export function publishMiddlewareError(
  options: PolicyEngineConfig,
  dispatchTrace: TraceContext.Type | undefined,
  timing: Policy.Timing,
  name: string,
  err: unknown,
  failPolicy: Policy.FailPolicy,
  durationMs: number,
): void {
  const traceId = nonEmptyTraceId(dispatchTrace) ?? nonEmptyTraceId(options.traceContext);
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
  dispatchTrace: TraceContext.Type | undefined,
  timing: Policy.Timing,
  name: string,
  verdict: Policy.PolicyDecision["verdict"],
  durationMs: number,
): void {
  const traceId = nonEmptyTraceId(dispatchTrace) ?? nonEmptyTraceId(options.traceContext);
  if (traceId === undefined) return;
  options.auditEmit?.(Operational.Debug, {
    traceId,
    time: Date.now(),
    component: "agent.policy",
    msg: "middleware dispatch",
    context: { timing, name, verdict, durationMs },
  });
}
