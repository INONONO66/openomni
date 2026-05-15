import { Bus } from "@openomni/session";
import {
  Operational,
  Policy,
  PolicyDecision as Decision,
  PolicyEvent,
  type RuntimeResource,
  type TraceContext,
} from "@openomni/protocol";
import { composeEffects } from "./effect-composition";
import type { PolicyContext, PolicyRegistration } from "./types";

const COMPOSED_POLICY_ID = "agent.policy.composed";
const EFFECT_VALIDATION_REASON = "policy.effect_not_allowed";
const MIDDLEWARE_ERROR_REASON = "middleware-error";

type AuditVisibility = "internal" | "llm_reason" | "user_audit";
type PolicyPointId = keyof typeof Policy.PolicyPoint.Registry;
type AuditDispatchContext = PolicyContext & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};

export type DispatchContext = Omit<PolicyContext, "timing"> & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};

export type PolicyDecision = Policy.PolicyDecision;

export interface PolicyAuditConfig {
  readonly sessionId?: string;
  readonly actor?: Record<string, unknown>;
  readonly action?: string;
  readonly resource?: string;
  readonly visibility?: AuditVisibility;
  readonly parentActionId?: string;
}

export interface PolicyEngineConfig {
  readonly onDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
  readonly traceContext?: TraceContext.Type;
  readonly audit?: PolicyAuditConfig | false;
}

export interface PolicyEngineInstance {
  register(reg: PolicyRegistration): void;
  dispatch(timing: Policy.Timing, ctx: DispatchContext): Promise<Policy.PolicyDecision>;
}

function matchesTiming(reg: PolicyRegistration, timing: Policy.Timing): boolean {
  return Array.isArray(reg.timing) ? reg.timing.includes(timing) : reg.timing === timing;
}

function matchesScope(reg: PolicyRegistration, agentType: string | undefined): boolean {
  const allowed = reg.scope?.agentType;
  if (!allowed || allowed.length === 0) return true;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

function selectRegistrations(
  registrations: PolicyRegistration[],
  timing: Policy.Timing,
  agentType: string | undefined,
): PolicyRegistration[] {
  return registrations
    .filter((reg) => matchesTiming(reg, timing) && matchesScope(reg, agentType))
    .sort((a, b) => a.priority - b.priority);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function immutableSnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => immutableSnapshot(entry))) as T;
  }

  if (isPlainRecord(value)) {
    const snapshot: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      snapshot[key] = immutableSnapshot(entry);
    }
    return Object.freeze(snapshot) as T;
  }

  return value;
}

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

function policyPointIdsForDescriptor(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): PolicyPointId[] {
  const aliases = Policy.PolicyPoint.MigrationMapping[timing];
  if (descriptor === undefined) return aliases;

  if (timing === "invoke.prepare") {
    if (descriptor.kind === "worker") {
      return descriptor.labels.includes("delegation.background")
        ? ["delegation.background.pre"]
        : ["delegation.subagent.pre"];
    }
    if (descriptor.kind === "tool") {
      return descriptor.source?.type === "mcp" || descriptor.source?.type === "skill-mcp"
        ? ["tool.mcp.pre"]
        : ["tool.native.pre"];
    }
  }

  if (timing === "invoke.result") {
    if (descriptor.kind === "worker") {
      return descriptor.labels.includes("delegation.background")
        ? ["delegation.background.post"]
        : ["delegation.subagent.post"];
    }
    if (descriptor.kind === "tool") {
      return descriptor.source?.type === "mcp" || descriptor.source?.type === "skill-mcp"
        ? ["tool.mcp.post"]
        : ["tool.native.post"];
    }
  }

  return aliases;
}

function auditPoint(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): { readonly pointId?: PolicyPointId; readonly pointVersion?: number } {
  const pointId = policyPointIdsForDescriptor(timing, descriptor)[0];
  if (pointId === undefined) return {};

  return { pointId, pointVersion: Policy.PolicyPoint.Registry[pointId].version };
}

function defaultFailPolicy(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.FailPolicy {
  const pointId = policyPointIdsForDescriptor(timing, descriptor)[0];
  if (pointId === undefined) return "fail-open";
  return Policy.PolicyPoint.Registry[pointId].defaultFailPolicy;
}

function totalDurationMs(decisions: readonly Policy.PolicyDecision[]): number {
  return decisions.reduce((total, decision) => total + (decision.durationMs ?? 0), 0);
}

function allowedEffectTypes(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Map<Policy.PolicyEffectType, PolicyPointId> {
  const allowed = new Map<Policy.PolicyEffectType, PolicyPointId>();

  for (const pointId of policyPointIdsForDescriptor(timing, descriptor)) {
    const point = Policy.PolicyPoint.Registry[pointId];
    for (const effectType of point.allowedEffects) {
      if (!allowed.has(effectType)) allowed.set(effectType, pointId);
    }
  }

  return allowed;
}

function validationFailure(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
  effects: readonly Policy.PolicyEffect[],
): Policy.PolicyDecision | undefined {
  const allowed = allowedEffectTypes(timing, descriptor);
  const invalid = effects.find((effect) => !allowed.has(effect.type));
  if (!invalid) return undefined;

  const pointId = policyPointIdsForDescriptor(timing, descriptor)[0];
  const annotation =
    pointId === undefined
      ? `${EFFECT_VALIDATION_REASON}: ${invalid.type} is not allowed at ${timing}`
      : `${EFFECT_VALIDATION_REASON}: ${invalid.type} is not allowed at ${pointId}`;

  return Decision.deny({
    policyId: COMPOSED_POLICY_ID,
    effects: [{ type: "audit.annotate", annotation, severity: "error" }],
    reasonCodes: [EFFECT_VALIDATION_REASON],
  });
}

// deny decisions at pre-boundary timings must include run.abort so downstream
// callers can distinguish "composition conflict deny" from "diagnostic-only deny".
function enforceDenyAbort(
  decision: Policy.PolicyDecision,
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.PolicyDecision {
  if (decision.verdict !== "deny") return decision;
  if (decision.effects.some((effect) => effect.type === "run.abort")) return decision;
  if (!allowedEffectTypes(timing, descriptor).has("run.abort")) return decision;

  const reason = decision.reasonCodes[0] ?? "policy.deny";
  return {
    ...decision,
    effects: [{ type: "run.abort", reason }, ...decision.effects],
  };
}

function composedDecision(
  effective: Policy.EffectiveDecision,
  decisions: readonly Policy.PolicyDecision[],
): Policy.PolicyDecision {
  const reasonSources =
    effective.verdict === "deny"
      ? decisions.filter((decision) => decision.verdict === "deny")
      : effective.verdict === "pending"
        ? decisions.filter((decision) => decision.verdict === "pending")
        : decisions;
  const reasonCodes = reasonSources.flatMap((decision) => decision.reasonCodes);
  const obligations = effective.obligations.length === 0 ? undefined : effective.obligations;

  return {
    policyId: COMPOSED_POLICY_ID,
    verdict: effective.verdict,
    effects: effective.mergedEffects,
    ...(obligations !== undefined && { obligations }),
    reasonCodes: [...new Set(reasonCodes)],
    durationMs: totalDurationMs(decisions),
  };
}

function middlewareErrorDecision(
  reg: PolicyRegistration,
  durationMs: number,
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.PolicyDecision {
  const effects: Policy.PolicyEffect[] = [
    {
      type: "audit.annotate",
      annotation: `${reg.name}: ${MIDDLEWARE_ERROR_REASON}`,
      severity: "error",
    },
  ];
  if (allowedEffectTypes(timing, descriptor).has("run.abort")) {
    effects.unshift({ type: "run.abort", reason: MIDDLEWARE_ERROR_REASON });
  }

  return Decision.deny({
    policyId: reg.name,
    reasonCodes: [MIDDLEWARE_ERROR_REASON],
    durationMs,
    priority: reg.priority,
    effects,
  });
}

function invalidDecision(
  reg: PolicyRegistration,
  durationMs: number,
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.PolicyDecision {
  const reason = "policy.invalid_decision";
  const effects: Policy.PolicyEffect[] = [
    {
      type: "audit.annotate",
      annotation: `${reg.name}: ${reason}`,
      severity: "error",
    },
  ];
  if (allowedEffectTypes(timing, descriptor).has("run.abort")) {
    effects.unshift({ type: "run.abort", reason });
  }

  return Decision.deny({
    policyId: reg.name,
    reasonCodes: [reason],
    durationMs,
    priority: reg.priority,
    effects,
  });
}

function normalizeDecision(
  decision: unknown,
  reg: PolicyRegistration,
  durationMs: number,
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): Policy.PolicyDecision {
  const parsed = Policy.PolicyDecision.safeParse(decision);
  if (!parsed.success) return invalidDecision(reg, durationMs, timing, descriptor);

  return {
    ...parsed.data,
    durationMs,
    priority: reg.priority,
  };
}

function create(options: PolicyEngineConfig = {}): PolicyEngineInstance {
  const registrations: PolicyRegistration[] = [];

  function publishPolicyEvent(
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

  function publishComposedDecision(
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

  async function recordDecision(
    reg: PolicyRegistration,
    ctx: AuditDispatchContext,
    decision: Policy.PolicyDecision,
  ): Promise<Policy.PolicyDecision> {
    publishPolicyEvent(decision, reg, ctx);
    await options.onDecision?.(decision);
    return decision;
  }

  async function dispatch(
    timing: Policy.Timing,
    ctx: DispatchContext,
  ): Promise<Policy.PolicyDecision> {
    const selected = selectRegistrations(registrations, timing, ctx.agentType);
    const fullCtx: AuditDispatchContext = immutableSnapshot({ ...ctx, timing });
    const decisions: Policy.PolicyDecision[] = [];

    function composeAndPublish(): Policy.PolicyDecision {
      const effective = composeEffects(decisions);
      const decision =
        validationFailure(timing, ctx.resourceDescriptor, effective.mergedEffects) ??
        composedDecision(effective, decisions);
      const enforced = enforceDenyAbort(decision, timing, ctx.resourceDescriptor);
      publishComposedDecision(timing, fullCtx, enforced);
      return enforced;
    }

    if (selected.length === 0) {
      const decision = Decision.allow({ policyId: COMPOSED_POLICY_ID });
      publishComposedDecision(timing, fullCtx, decision);
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
        Bus.publish(Operational.Warn, {
          traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
          time: Date.now(),
          component: "agent.policy",
          msg: "middleware error",
          context: { timing, name: reg.name, error: String(err), failPolicy, durationMs },
        });
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
      decisions.push(await recordDecision(reg, fullCtx, normalized));

      Bus.publish(Operational.Debug, {
        traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
        time: Date.now(),
        component: "agent.policy",
        msg: "middleware dispatch",
        context: { timing, name: reg.name, verdict: normalized.verdict, durationMs },
      });

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
