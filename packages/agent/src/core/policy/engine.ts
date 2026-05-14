import { Bus } from "@openomni/session";
import {
  Operational,
  Policy,
  PolicyEvent,
  type RuntimeResource,
  type TraceContext,
} from "@openomni/protocol";
import { composeEffects } from "./effect-composition";
import type { PolicyContext, PolicyRegistration } from "./types";
import { verdictToDecision } from "./verdict-adapter";

const CONTINUE: Policy.Verdict = { action: "continue" };
const COMPOSED_POLICY_ID = "agent.policy.composed";
const EFFECT_VALIDATION_REASON = "policy.effect_not_allowed";
const POLICY_METADATA_MISSING: Policy.Verdict = {
  action: "deny",
  reason: "policy-metadata-missing",
  policyId: "agent.policy.metadata",
};

type AuditVisibility = "internal" | "llm_reason" | "user_audit";
type PolicyEventVerdict = Exclude<Policy.Verdict["action"], "deny">;

type PolicyPointId = keyof typeof Policy.PolicyPoint.Registry;

export type DispatchV2Context = Omit<PolicyContext, "timing"> & {
  readonly resourceDescriptor?: RuntimeResource.Descriptor;
};

export interface PolicyDecision {
  readonly timing: Policy.Timing;
  readonly name: string;
  readonly policyId: string;
  readonly verdict: Policy.Verdict["action"];
  readonly reason?: string;
  readonly durationMs: number;
  readonly traceContext?: TraceContext.Type;
  readonly envelope?: PolicyContext["envelope"];
}

export interface PolicyAuditConfig {
  readonly sessionId?: string;
  readonly actor?: Record<string, unknown>;
  readonly action?: string;
  readonly resource?: string;
  readonly visibility?: AuditVisibility;
  readonly parentActionId?: string;
}

export interface PolicyEngineConfig {
  readonly onDecision?: (decision: PolicyDecision) => void | Promise<void>;
  readonly traceContext?: TraceContext.Type;
  readonly audit?: PolicyAuditConfig | false;
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

export interface PolicyEngineInstance {
  register(reg: PolicyRegistration): void;
  dispatch(timing: Policy.Timing, ctx: Omit<PolicyContext, "timing">): Promise<Policy.Verdict>;
  dispatchV2(timing: Policy.Timing, ctx: DispatchV2Context): Promise<Policy.PolicyDecision>;
  dispatchSystemPrompt(ctx: Omit<PolicyContext, "timing">): Promise<Policy.SystemPromptResult>;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function warnKey(timing: Policy.Timing, name: string): string {
  return `${timing}:${name}`;
}

function isPreBoundaryTiming(timing: Policy.Timing): boolean {
  return (
    timing === "inbound.receive" ||
    timing === "run.start" ||
    timing === "turn.start" ||
    timing === "context.prepare" ||
    timing === "resources.prepare" ||
    timing === "model.request" ||
    timing === "invoke.prepare" ||
    timing === "completion.prepare" ||
    timing === "writeback.commit"
  );
}

function systemPromptTerminalError(verdict: Policy.Verdict, name: string): Error {
  const reason = verdict.reason ?? verdict.action;
  const policyId = verdict.policyId ?? "unknown";
  return new Error(
    `System prompt policy ${name} returned ${verdict.action}: ${reason} (${policyId})`,
  );
}

function normalizeVerdict(
  verdict: Policy.Verdict,
  timing: Policy.Timing,
  name: string,
  warnedMissingMetadata: Set<string>,
): Policy.Verdict {
  const missingReason = verdict.action !== "continue" && !verdict.reason;
  const missingPolicyId = !verdict.policyId;

  if (isProduction() && isPreBoundaryTiming(timing) && (missingReason || missingPolicyId)) {
    return POLICY_METADATA_MISSING;
  }

  if (missingReason && !isProduction()) {
    throw new Error(`Middleware ${name} returned ${verdict.action} without reason at ${timing}`);
  }

  if (isProduction() && (missingReason || missingPolicyId)) {
    const key = warnKey(timing, name);
    if (!warnedMissingMetadata.has(key)) {
      warnedMissingMetadata.add(key);
      Bus.publish(Operational.Warn, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        component: "agent.policy",
        msg: "middleware verdict missing policy metadata",
        context: { timing, name, verdict: verdict.action, missingReason, missingPolicyId },
      });
    }
  }

  return isProduction() && missingPolicyId ? { ...verdict, policyId: "unknown" } : verdict;
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

function resolveEventReason(decision: PolicyDecision): string {
  if (decision.reason) return decision.reason;
  return decision.verdict === "continue" ? "continue" : "unspecified";
}

function policyPointIdsForDescriptor(
  timing: Policy.Timing,
  descriptor: RuntimeResource.Descriptor | undefined,
): PolicyPointId[] {
  const aliases = Policy.PolicyPoint.MigrationMapping[timing];
  if (descriptor === undefined) return aliases;

  if (timing === "invoke.prepare") {
    if (descriptor.kind === "worker") return ["delegation.subagent.pre"];
    if (descriptor.kind === "tool") {
      return descriptor.source?.type === "mcp" || descriptor.source?.type === "skill-mcp"
        ? ["tool.mcp.pre"]
        : ["tool.native.pre"];
    }
  }

  if (timing === "invoke.result") {
    if (descriptor.kind === "worker") return ["delegation.subagent.post"];
    if (descriptor.kind === "tool") {
      return descriptor.source?.type === "mcp" || descriptor.source?.type === "skill-mcp"
        ? ["tool.mcp.post"]
        : ["tool.native.post"];
    }
  }

  return aliases;
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

  return {
    policyId: COMPOSED_POLICY_ID,
    verdict: "deny",
    effects: [{ type: "audit.annotate", annotation, severity: "error" }],
    reasonCodes: [EFFECT_VALIDATION_REASON],
  };
}

function composedDecision(
  effective: Policy.EffectiveDecision,
  decisions: readonly Policy.PolicyDecision[],
): Policy.PolicyDecision {
  const reasonCodes = decisions.flatMap((decision) => decision.reasonCodes);
  const obligations = effective.obligations.length === 0 ? undefined : effective.obligations;

  return {
    policyId: COMPOSED_POLICY_ID,
    verdict: effective.verdict,
    effects: effective.mergedEffects,
    ...(obligations !== undefined && { obligations }),
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function create(options: PolicyEngineConfig = {}): PolicyEngineInstance {
  const registrations: PolicyRegistration[] = [];
  const warnedMissingMetadata = new Set<string>();

  function publishPolicyEvent(
    decision: PolicyDecision,
    reg: PolicyRegistration,
    ctx: PolicyContext,
  ): void {
    if (options.audit === false) return;

    const traceContext = decision.traceContext;
    const traceId = traceContext?.traceId;
    const sessionId = options.audit?.sessionId ?? traceContext?.sessionId;
    if (!sessionId || !traceId) return;

    Bus.publish(PolicyEvent.Evaluated, {
      traceId,
      sessionId,
      ...(traceContext?.runId !== undefined && { runId: traceContext.runId }),
      time: Date.now(),
      policyId: decision.policyId,
      actor: options.audit?.actor ?? buildActor(traceContext),
      action: options.audit?.action ?? resolveAction(decision.timing),
      resource: options.audit?.resource ?? resolveResource(reg, ctx),
      verdict: decision.verdict as PolicyEventVerdict,
      reason: resolveEventReason(decision),
    });
  }

  async function recordDecision(
    reg: PolicyRegistration,
    ctx: PolicyContext,
    verdict: Policy.Verdict,
    durationMs: number,
  ): Promise<Policy.Verdict> {
    const normalized = normalizeVerdict(verdict, ctx.timing, reg.name, warnedMissingMetadata);
    const traceContext = ctx.traceContext ?? options.traceContext;
    const decision: PolicyDecision = {
      timing: ctx.timing,
      name: reg.name,
      policyId: normalized.policyId ?? "unknown",
      verdict: normalized.action,
      durationMs,
      ...(normalized.reason !== undefined && { reason: normalized.reason }),
      ...(traceContext !== undefined && { traceContext }),
      ...(ctx.envelope !== undefined && { envelope: ctx.envelope }),
    };

    publishPolicyEvent(decision, reg, ctx);
    await options.onDecision?.(decision);
    return normalized;
  }

  async function dispatch(
    timing: Policy.Timing,
    ctx: Omit<PolicyContext, "timing">,
  ): Promise<Policy.Verdict> {
    const selected = selectRegistrations(registrations, timing, ctx.agentType);
    const fullCtx: PolicyContext = { ...ctx, timing };

    for (const reg of selected) {
      let verdict: Policy.Verdict;
      const startTime = Date.now();
      try {
        verdict = await reg.fn(fullCtx);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const failPolicy = reg.failPolicy ?? "fail-open";
        Bus.publish(Operational.Warn, {
          traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
          time: Date.now(),
          component: "agent.policy",
          msg: "middleware error",
          context: { timing, name: reg.name, error: String(err), failPolicy, durationMs },
        });
        if (failPolicy === "fail-closed") {
          return { action: "abort", reason: "middleware-error" };
        }
        continue;
      }

      const durationMs = Date.now() - startTime;
      verdict = await recordDecision(reg, fullCtx, verdict, durationMs);
      Bus.publish(Operational.Debug, {
        traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
        time: Date.now(),
        component: "agent.policy",
        msg: "middleware dispatch",
        context: { timing, name: reg.name, verdict: verdict.action, durationMs },
      });

      if (verdict.action !== "continue") {
        return verdict;
      }
    }

    return CONTINUE;
  }

  async function dispatchV2(
    timing: Policy.Timing,
    ctx: DispatchV2Context,
  ): Promise<Policy.PolicyDecision> {
    const selected = selectRegistrations(registrations, timing, ctx.agentType);
    const fullCtx: PolicyContext = { ...ctx, timing };
    const decisions: Policy.PolicyDecision[] = [];

    for (const reg of selected) {
      let verdict: Policy.Verdict;
      const startTime = Date.now();
      try {
        verdict = await reg.fn(fullCtx);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const failPolicy = reg.failPolicy ?? "fail-open";
        Bus.publish(Operational.Warn, {
          traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
          time: Date.now(),
          component: "agent.policy",
          msg: "middleware error",
          context: { timing, name: reg.name, error: String(err), failPolicy, durationMs },
        });
        if (failPolicy === "fail-open") continue;

        verdict = { action: "abort", reason: "middleware-error", policyId: reg.name };
      }

      const durationMs = Date.now() - startTime;
      const normalized = await recordDecision(reg, fullCtx, verdict, durationMs);
      const decision = verdictToDecision(normalized, {
        timing,
        policyId: normalized.policyId ?? reg.name,
        ...(ctx.toolName !== undefined && { toolName: ctx.toolName }),
      });
      const prioritizedDecision = { ...decision, durationMs, priority: reg.priority };
      decisions.push(prioritizedDecision);

      Bus.publish(Operational.Debug, {
        traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
        time: Date.now(),
        component: "agent.policy",
        msg: "middleware dispatch.v2",
        context: { timing, name: reg.name, verdict: decision.verdict, durationMs },
      });

      if (verdict.action === "abort" && reg.failPolicy === "fail-closed") break;
    }

    const effective = composeEffects(decisions);
    return (
      validationFailure(timing, ctx.resourceDescriptor, effective.mergedEffects) ??
      composedDecision(effective, decisions)
    );
  }

  async function dispatchSystemPrompt(
    ctx: Omit<PolicyContext, "timing">,
  ): Promise<Policy.SystemPromptResult> {
    const selected = selectRegistrations(registrations, "context.prepare", ctx.agentType);
    const fullCtx: PolicyContext = { ...ctx, timing: "context.prepare" };

    let systemPrompt: string | undefined;
    const prependParts: string[] = [];
    const appendParts: string[] = [];

    for (const reg of selected) {
      let verdict: Policy.Verdict;
      const startTime = Date.now();
      try {
        verdict = await reg.fn(fullCtx);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const failPolicy = reg.failPolicy ?? "fail-open";
        Bus.publish(Operational.Warn, {
          traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
          time: Date.now(),
          component: "agent.policy",
          msg: "middleware error",
          context: {
            timing: "context.prepare",
            name: reg.name,
            error: String(err),
            failPolicy,
            durationMs,
          },
        });
        if (failPolicy === "fail-closed") {
          throw err;
        }
        continue;
      }

      const durationMs = Date.now() - startTime;
      verdict = await recordDecision(reg, fullCtx, verdict, durationMs);
      Bus.publish(Operational.Debug, {
        traceId: options.traceContext?.traceId ?? crypto.randomUUID(),
        time: Date.now(),
        component: "agent.policy",
        msg: "middleware dispatch",
        context: {
          timing: "context.prepare",
          name: reg.name,
          verdict: verdict.action,
          durationMs,
        },
      });

      if (verdict.action === "transform") {
        const input = verdict.input as {
          systemPrompt?: unknown;
          prependContext?: unknown;
          appendContext?: unknown;
        };
        if (systemPrompt === undefined && typeof input.systemPrompt === "string") {
          systemPrompt = input.systemPrompt;
        }
        if (typeof input.prependContext === "string") {
          prependParts.push(input.prependContext);
        }
        if (typeof input.appendContext === "string") {
          appendParts.push(input.appendContext);
        }
      } else if (verdict.action === "inject") {
        appendParts.push(verdict.message);
      } else if (verdict.action === "deny" || verdict.action === "abort") {
        throw systemPromptTerminalError(verdict, reg.name);
      }
    }

    const result: Policy.SystemPromptResult = {};
    if (systemPrompt !== undefined) result.systemPrompt = systemPrompt;
    if (prependParts.length > 0) result.prependContext = prependParts.join("\n\n");
    if (appendParts.length > 0) result.appendContext = appendParts.join("\n\n");
    return result;
  }

  return {
    register(reg) {
      registrations.push(reg);
    },
    dispatch,
    dispatchV2,
    dispatchSystemPrompt,
  };
}

export const PolicyEngine = { create };
