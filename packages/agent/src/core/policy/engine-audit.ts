import { Operational, type Policy, PolicyEvent, type TraceContext } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { auditPoint } from "./engine-points";
import type { AuditDispatchContext, PolicyEngineConfig } from "./engine-types";
import type { PolicyContext, PolicyRegistration } from "./types";

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

function resolveResource(reg: PolicyRegistration, ctx: PolicyContext): string {
  return ctx.toolName ?? reg.name;
}

function resolveComposedResource(ctx: AuditDispatchContext): string {
  return ctx.toolName ?? ctx.resourceDescriptor?.id ?? "policy.composed";
}

function auditReason(decision: Policy.PolicyDecision): string {
  if (decision.reasonCodes.length > 0) return decision.reasonCodes.join(",");
  return decision.verdict;
}

export function publishPolicyEvent(
  options: PolicyEngineConfig,
  decision: Policy.PolicyDecision,
  reg: PolicyRegistration,
  ctx: AuditDispatchContext,
): void {
  if (options.audit === false) return;

  const traceContext = ctx.traceContext ?? options.traceContext;
  const traceId = traceContext?.traceId;
  const sessionId = options.audit?.sessionId ?? traceContext?.sessionId;
  if (!sessionId || !traceId) return;
  const point = auditPoint(ctx.timing, ctx.resourceDescriptor);

  Bus.publish(PolicyEvent.Evaluated, {
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
    ...point,
    ...(ctx.resourceDescriptor !== undefined && { resourceDescriptor: ctx.resourceDescriptor }),
  });
}

export function publishComposedDecision(
  options: PolicyEngineConfig,
  timing: Policy.Timing,
  ctx: AuditDispatchContext,
  decision: Policy.PolicyDecision,
): void {
  if (options.audit === false) return;

  const traceContext = ctx.traceContext ?? options.traceContext;
  const traceId = traceContext?.traceId;
  const sessionId = options.audit?.sessionId ?? traceContext?.sessionId;
  if (!sessionId || !traceId) return;

  Bus.publish(PolicyEvent.DecisionComposed, {
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
    ...auditPoint(timing, ctx.resourceDescriptor),
    ...(ctx.resourceDescriptor !== undefined && { resourceDescriptor: ctx.resourceDescriptor }),
  });
}

export function publishDecisionObserverError(
  options: PolicyEngineConfig,
  ctx: AuditDispatchContext,
  decision: Policy.PolicyDecision,
  err: unknown,
): void {
  const traceContext = ctx.traceContext ?? options.traceContext;
  Bus.publish(Operational.Warn, {
    traceId: traceContext?.traceId ?? crypto.randomUUID(),
    time: Date.now(),
    ...(traceContext?.sessionId !== undefined && { sessionId: traceContext.sessionId }),
    component: "agent.policy",
    msg: "onDecision observer error",
    context: { timing: ctx.timing, policyId: decision.policyId, error: String(err) },
  });
}
