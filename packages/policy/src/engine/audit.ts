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

export function publishPolicyEvent(
  options: PolicyEngineConfig,
  decision: Policy.PolicyDecision,
  reg: { name: string },
  ctx: Readonly<AuditDispatchContextGeneric<GenericPolicyContext>>,
): void {
  if (options.audit === false) return;

  const traceContext = ctx.traceContext ?? options.traceContext;
  const traceId = traceContext?.traceId;
  const sessionId = options.audit?.sessionId ?? traceContext?.sessionId;
  if (!sessionId || !traceId) return;

  options.auditEmit?.(PolicyEvent.Evaluated, {
    traceId,
    sessionId,
    ...(traceContext?.runId !== undefined && { runId: traceContext.runId }),
    time: Date.now(),
    policyId: decision.policyId,
    actor: options.audit?.actor ?? buildActor(traceContext),
    action: options.audit?.action ?? resolveAction(ctx.timing),
    resource: options.audit?.resource ?? resolveResource(reg, ctx),
    verdict: decision.verdict,
    reason: auditReason(decision),
    effects: decision.effects,
    ...(decision.obligations !== undefined && { obligations: decision.obligations }),
    reasonCodes: decision.reasonCodes,
    ...(decision.factsUsed !== undefined && { factsUsed: decision.factsUsed }),
    durationMs: decision.durationMs,
    ...resolveAuditPoint(ctx),
    ...(ctx.resourceDescriptor !== undefined && { resourceDescriptor: ctx.resourceDescriptor }),
  });
}

export function publishComposedDecision(
  options: PolicyEngineConfig,
  timing: Policy.Timing,
  ctx: Readonly<AuditDispatchContextGeneric<GenericPolicyContext>>,
  decision: Policy.PolicyDecision,
): void {
  if (options.audit === false) return;

  const traceContext = ctx.traceContext ?? options.traceContext;
  const traceId = traceContext?.traceId;
  const sessionId = options.audit?.sessionId ?? traceContext?.sessionId;
  if (!sessionId || !traceId) return;

  options.auditEmit?.(PolicyEvent.DecisionComposed, {
    traceId,
    sessionId,
    ...(traceContext?.runId !== undefined && { runId: traceContext.runId }),
    time: Date.now(),
    actor: options.audit?.actor ?? buildActor(traceContext),
    action: options.audit?.action ?? resolveAction(timing),
    resource: options.audit?.resource ?? resolveComposedResource(ctx),
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
  options.auditEmit?.(Operational.Warn, {
    traceId: traceContext?.traceId ?? crypto.randomUUID(),
    time: Date.now(),
    ...(traceContext?.sessionId !== undefined && { sessionId: traceContext.sessionId }),
    component: "agent.policy",
    msg: "onDecision observer error",
    context: { timing: ctx.timing, policyId: decision.policyId, error: String(err) },
  });
}
