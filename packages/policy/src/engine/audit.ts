import { Operational, Policy, PolicyEvent, type TraceContext } from "@openomni/protocol";
import type {
  AuditDispatchContextGeneric,
  GenericPolicyContext,
  PolicyEngineConfig,
} from "./types";

function buildActor(traceContext: TraceContext.Type | undefined): Record<string, unknown> {
  return {
    kind: "agent",
    ...(traceContext?.agentName !== undefined && { name: traceContext.agentName }),
    ...(traceContext?.runId !== undefined && { runId: traceContext.runId }),
    ...(traceContext?.taskId !== undefined && { taskId: traceContext.taskId }),
  };
}

function resolveAction(timing: Policy.Timing): string {
  if (timing === "invoke.prepare" || timing === "invoke.result") return "tool.call";
  return `middleware.${timing}`;
}

function resolveResource(reg: { name: string }, ctx: GenericPolicyContext): string {
  return ctx.toolName ?? reg.name;
}

function resolveComposedResource(
  ctx: Readonly<AuditDispatchContextGeneric<GenericPolicyContext>>,
): string {
  return ctx.toolName ?? ctx.resourceDescriptor?.id ?? "policy.composed";
}

function auditReason(decision: Policy.PolicyDecision): string {
  if (decision.reasonCodes.length > 0) return decision.reasonCodes.join(",");
  return decision.verdict;
}

function resolveAuditPoint(ctx: Readonly<AuditDispatchContextGeneric<GenericPolicyContext>>): {
  readonly pointId?: string;
  readonly pointVersion?: number;
} {
  // Every dispatch is canonical since #530, so the audit context always
  // carries its point; the guard only covers hand-built audit contexts.
  if (ctx.pointId === undefined) return {};
  return {
    pointId: ctx.pointId,
    pointVersion: Policy.PolicyPoint.Registry[ctx.pointId].version,
  };
}

/**
 * Whether anything will read an audit context. Not every engine binds one:
 * the completion-admission engine is built as `PolicyEngine.create()` with no
 * options (`packages/openomni/src/dispatch/setup.ts`), so building a
 * correlation context for its dispatches is pure waste.
 */
export function auditIsConsumed(options: PolicyEngineConfig): boolean {
  return options.audit !== false && options.auditEmit !== undefined;
}

export function publishPolicyEvent(
  options: PolicyEngineConfig,
  decision: Policy.PolicyDecision,
  reg: { name: string },
  ctx: Readonly<AuditDispatchContextGeneric<GenericPolicyContext>>,
): void {
  publishAuditRecord(options, ctx, decision, {
    descriptor: PolicyEvent.Evaluated,
    action: resolveAction(ctx.timing),
    resource: resolveResource(reg, ctx),
    policyId: decision.policyId,
  });
}

export function publishComposedDecision(
  options: PolicyEngineConfig,
  timing: Policy.Timing,
  ctx: Readonly<AuditDispatchContextGeneric<GenericPolicyContext>>,
  decision: Policy.PolicyDecision,
): void {
  publishAuditRecord(options, ctx, decision, {
    descriptor: PolicyEvent.DecisionComposed,
    action: resolveAction(timing),
    resource: resolveComposedResource(ctx),
  });
}

/**
 * One assembly for both audit records: the pair drifted before (same gate,
 * same 10-field record, hand-copied). Gating stays sessionId AND traceId —
 * stricter than the middleware-error publishers, which file under a trace
 * alone; an audit row without its session names nothing queryable.
 */
function publishAuditRecord(
  options: PolicyEngineConfig,
  ctx: Readonly<AuditDispatchContextGeneric<GenericPolicyContext>>,
  decision: Policy.PolicyDecision,
  record: {
    descriptor: typeof PolicyEvent.Evaluated | typeof PolicyEvent.DecisionComposed;
    action: string;
    resource: string;
    policyId?: string;
  },
): void {
  if (options.audit === false) return;

  const traceContext = ctx.traceContext ?? options.traceContext;
  const traceId = traceContext?.traceId;
  const sessionId = options.audit?.sessionId ?? traceContext?.sessionId;
  if (!sessionId || !traceId) return;

  options.auditEmit?.(record.descriptor, {
    traceId,
    sessionId,
    ...(traceContext?.runId !== undefined && { runId: traceContext.runId }),
    time: Date.now(),
    ...(record.policyId !== undefined && { policyId: record.policyId }),
    actor: options.audit?.actor ?? buildActor(traceContext),
    action: options.audit?.action ?? record.action,
    resource: options.audit?.resource ?? record.resource,
    verdict: decision.verdict,
    reason: auditReason(decision),
    effects: decision.effects,
    reasonCodes: decision.reasonCodes,
    ...(decision.obligations !== undefined && { obligations: decision.obligations }),
    ...(decision.factsUsed !== undefined && { factsUsed: decision.factsUsed }),
    durationMs: decision.durationMs,
    ...resolveAuditPoint(ctx),
    ...(ctx.resourceDescriptor !== undefined && { resourceDescriptor: ctx.resourceDescriptor }),
  });
}

export function publishDecisionObserverError(
  options: PolicyEngineConfig,
  ctx: Readonly<AuditDispatchContextGeneric<GenericPolicyContext>>,
  decision: Policy.PolicyDecision,
  err: unknown,
): void {
  const traceContext = ctx.traceContext ?? options.traceContext;
  const traceId = traceContext?.traceId;
  if (traceId === undefined || traceId.length === 0) return;
  options.auditEmit?.(Operational.Warn, {
    traceId,
    time: Date.now(),
    ...(traceContext?.sessionId !== undefined && { sessionId: traceContext.sessionId }),
    component: "agent.policy",
    msg: "onDecision observer error",
    context: { timing: ctx.timing, policyId: decision.policyId, error: String(err) },
  });
}
