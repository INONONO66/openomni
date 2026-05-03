import { EventLog, Log } from "@openomni/session";
import type { ExecutionEvent, Hook, Middleware, TraceContext } from "@openomni/protocol";
import type { MiddlewareContext, MiddlewareRegistration } from "./types";

const CONTINUE: Hook.Verdict = { action: "continue" };

type DurableVisibility = ExecutionEvent.PolicyEvaluated["visibility"];

export interface MiddlewareDecision {
  readonly timing: Hook.Timing;
  readonly name: string;
  readonly policyId: string;
  readonly verdict: Hook.Verdict["action"];
  readonly reason?: string;
  readonly durationMs: number;
  readonly traceContext?: TraceContext.Type;
  readonly envelope?: MiddlewareContext["envelope"];
}

export interface MiddlewareEventLogConfig {
  readonly sessionId?: string;
  readonly actor?: Record<string, unknown>;
  readonly action?: string;
  readonly resource?: string;
  readonly visibility?: DurableVisibility;
  readonly parentActionId?: string;
}

export interface MiddlewareEngineConfig {
  readonly onDecision?: (decision: MiddlewareDecision) => void | Promise<void>;
  readonly traceContext?: TraceContext.Type;
  readonly eventLog?: MiddlewareEventLogConfig | false;
}

function matchesTiming(reg: MiddlewareRegistration, timing: Hook.Timing): boolean {
  return Array.isArray(reg.timing) ? reg.timing.includes(timing) : reg.timing === timing;
}

function matchesScope(reg: MiddlewareRegistration, agentType: string | undefined): boolean {
  const allowed = reg.scope?.agentType;
  if (!allowed || allowed.length === 0) return true;
  if (!agentType) return false;
  return allowed.includes(agentType);
}

function selectRegistrations(
  registrations: MiddlewareRegistration[],
  timing: Hook.Timing,
  agentType: string | undefined,
): MiddlewareRegistration[] {
  return registrations
    .filter((reg) => matchesTiming(reg, timing) && matchesScope(reg, agentType))
    .sort((a, b) => a.priority - b.priority);
}

export interface MiddlewareEngineInstance {
  register(reg: MiddlewareRegistration): void;
  dispatch(timing: Hook.Timing, ctx: Omit<MiddlewareContext, "timing">): Promise<Hook.Verdict>;
  dispatchSystemPrompt(
    ctx: Omit<MiddlewareContext, "timing">,
  ): Promise<Middleware.SystemPromptVerdict>;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function warnKey(timing: Hook.Timing, name: string): string {
  return `${timing}:${name}`;
}

function normalizeVerdict(
  verdict: Hook.Verdict,
  timing: Hook.Timing,
  name: string,
  warnedMissingMetadata: Set<string>,
): Hook.Verdict {
  const missingReason = verdict.action !== "continue" && !verdict.reason;
  const missingPolicyId = !verdict.policyId;

  if (missingReason && !isProduction()) {
    throw new Error(`Middleware ${name} returned ${verdict.action} without reason at ${timing}`);
  }

  if (isProduction() && (missingReason || missingPolicyId)) {
    const key = warnKey(timing, name);
    if (!warnedMissingMetadata.has(key)) {
      warnedMissingMetadata.add(key);
      Log.warn("middleware verdict missing policy metadata", {
        timing,
        name,
        verdict: verdict.action,
        missingReason,
        missingPolicyId,
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

function resolveAction(timing: Hook.Timing): string {
  if (timing === "pre_tool_use" || timing === "post_tool_use") return "tool.call";
  return `middleware.${timing}`;
}

function resolveResource(reg: MiddlewareRegistration, ctx: MiddlewareContext): string {
  return ctx.toolName ?? reg.name;
}

function resolveEventReason(decision: MiddlewareDecision): string {
  if (decision.reason) return decision.reason;
  return decision.verdict === "continue" ? "continue" : "unspecified";
}

function createActionId(
  sessionId: string,
  timing: Hook.Timing,
  name: string,
  sequence: number,
): string {
  return `${sessionId}:middleware.${timing}:${name}:${sequence}`;
}

async function readNextSequence(sessionId: string): Promise<number> {
  let maxSequence = 0;
  for await (const event of EventLog.replay(sessionId)) {
    maxSequence = Math.max(maxSequence, event.sequence);
  }
  return maxSequence + 1;
}

function create(options: MiddlewareEngineConfig = {}): MiddlewareEngineInstance {
  const registrations: MiddlewareRegistration[] = [];
  const warnedMissingMetadata = new Set<string>();
  const sequenceReservations = new Map<string, Promise<number>>();

  function reserveSequence(sessionId: string): Promise<number> {
    const current = sequenceReservations.get(sessionId) ?? readNextSequence(sessionId);
    sequenceReservations.set(
      sessionId,
      current.then(
        (sequence) => sequence + 1,
        () => 1,
      ),
    );
    return current;
  }

  async function appendPolicyEvent(
    decision: MiddlewareDecision,
    reg: MiddlewareRegistration,
    ctx: MiddlewareContext,
  ): Promise<void> {
    if (options.eventLog === false) return;

    const traceContext = decision.traceContext;
    const sessionId = options.eventLog?.sessionId ?? traceContext?.sessionId;
    if (!sessionId) return;

    const sequence = await reserveSequence(sessionId);
    await EventLog.append(sessionId, {
      type: "policy_evaluated",
      policyId: decision.policyId,
      actor: options.eventLog?.actor ?? buildActor(traceContext),
      action: options.eventLog?.action ?? resolveAction(decision.timing),
      resource: options.eventLog?.resource ?? resolveResource(reg, ctx),
      verdict: decision.verdict,
      reason: resolveEventReason(decision),
      actionId: createActionId(sessionId, decision.timing, decision.name, sequence),
      ...(options.eventLog?.parentActionId !== undefined && {
        parentActionId: options.eventLog.parentActionId,
      }),
      visibility: options.eventLog?.visibility ?? "internal",
      timestamp: new Date().toISOString(),
      sequence,
    });
  }

  async function recordDecision(
    reg: MiddlewareRegistration,
    ctx: MiddlewareContext,
    verdict: Hook.Verdict,
    durationMs: number,
  ): Promise<Hook.Verdict> {
    const normalized = normalizeVerdict(verdict, ctx.timing, reg.name, warnedMissingMetadata);
    const traceContext = ctx.traceContext ?? options.traceContext;
    const decision: MiddlewareDecision = {
      timing: ctx.timing,
      name: reg.name,
      policyId: normalized.policyId ?? "unknown",
      verdict: normalized.action,
      durationMs,
      ...(normalized.reason !== undefined && { reason: normalized.reason }),
      ...(traceContext !== undefined && { traceContext }),
      ...(ctx.envelope !== undefined && { envelope: ctx.envelope }),
    };

    await appendPolicyEvent(decision, reg, ctx);
    await options.onDecision?.(decision);
    return normalized;
  }

  async function dispatch(
    timing: Hook.Timing,
    ctx: Omit<MiddlewareContext, "timing">,
  ): Promise<Hook.Verdict> {
    const selected = selectRegistrations(registrations, timing, ctx.agentType);
    const fullCtx: MiddlewareContext = { ...ctx, timing };

    for (const reg of selected) {
      let verdict: Hook.Verdict;
      const startTime = Date.now();
      try {
        verdict = await reg.fn(fullCtx);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const failPolicy = reg.failPolicy ?? "fail-open";
        Log.warn("middleware error", {
          timing,
          name: reg.name,
          error: String(err),
          failPolicy,
          durationMs,
        });
        if (failPolicy === "fail-closed") {
          return { action: "abort", reason: "middleware-error" };
        }
        continue;
      }

      const durationMs = Date.now() - startTime;
      verdict = await recordDecision(reg, fullCtx, verdict, durationMs);
      Log.debug("middleware dispatch", {
        timing,
        name: reg.name,
        verdict: verdict.action,
        durationMs,
      });

      if (verdict.action !== "continue") {
        return verdict;
      }
    }

    return CONTINUE;
  }

  async function dispatchSystemPrompt(
    ctx: Omit<MiddlewareContext, "timing">,
  ): Promise<Middleware.SystemPromptVerdict> {
    const selected = selectRegistrations(registrations, "on_system_prompt", ctx.agentType);
    const fullCtx: MiddlewareContext = { ...ctx, timing: "on_system_prompt" };

    let systemPrompt: string | undefined;
    const prependParts: string[] = [];
    const appendParts: string[] = [];

    for (const reg of selected) {
      let verdict: Hook.Verdict;
      const startTime = Date.now();
      try {
        verdict = await reg.fn(fullCtx);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const failPolicy = reg.failPolicy ?? "fail-open";
        Log.warn("middleware error", {
          timing: "on_system_prompt",
          name: reg.name,
          error: String(err),
          failPolicy,
          durationMs,
        });
        if (failPolicy === "fail-closed") {
          throw err;
        }
        continue;
      }

      const durationMs = Date.now() - startTime;
      verdict = await recordDecision(reg, fullCtx, verdict, durationMs);
      Log.debug("middleware dispatch", {
        timing: "on_system_prompt",
        name: reg.name,
        verdict: verdict.action,
        durationMs,
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
      }
    }

    const result: Middleware.SystemPromptVerdict = {};
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
    dispatchSystemPrompt,
  };
}

export const MiddlewareEngine = { create };
