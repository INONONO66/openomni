import { EventLog, Log } from "@openomni/session";
import type { ExecutionEvent, Guardrail, Policy, TraceContext } from "@openomni/protocol";
import type {
  PolicyContext,
  PolicyEngineInstance,
  PolicyRegistration,
  PolicySystemPromptVerdict,
  PolicyVerdict,
} from "./types";

const CONTINUE: Policy.Verdict = { action: "continue" };
const POLICY_ID = "guardrail.permission";
const MAX_REGEX_PATTERN_LENGTH = 200;
const MAX_INPUT_LENGTH = 10_000;

type DurableVisibility = ExecutionEvent.PolicyEvaluated["visibility"];
type EventVerdict = ExecutionEvent.PolicyEvaluated["verdict"];

export interface PolicyDecision {
  readonly timing: Policy.Timing;
  readonly label: string;
  readonly policyId: string;
  readonly verdict: PolicyVerdict;
  readonly reason?: string;
  readonly durationMs: number;
  readonly traceContext?: TraceContext.Type;
  readonly envelope?: PolicyContext["envelope"];
}

export interface PolicyAuditConfig {
  readonly enabled?: boolean;
  readonly sessionId?: string;
  readonly actor?: Record<string, unknown>;
  readonly action?: string;
  readonly resource?: string;
  readonly visibility?: DurableVisibility;
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

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function warnKey(timing: Policy.Timing, label: string): string {
  return `${timing}:${label}`;
}

function normalizeVerdict(
  verdict: PolicyVerdict,
  timing: Policy.Timing,
  label: string,
  warnedMissingMetadata: Set<string>,
): PolicyVerdict {
  const missingReason = verdict.action !== "continue" && !verdict.reason;
  const missingPolicyId = !verdict.policyId;

  if (missingReason && !isProduction()) {
    throw new Error(`Policy ${label} returned ${verdict.action} without reason at ${timing}`);
  }

  if (isProduction() && (missingReason || missingPolicyId)) {
    const key = warnKey(timing, label);
    if (!warnedMissingMetadata.has(key)) {
      warnedMissingMetadata.add(key);
      Log.warn("policy verdict missing metadata", {
        timing,
        label,
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

function resolveAction(timing: Policy.Timing, ctx: PolicyContext): string {
  if (ctx.action) return ctx.action;
  if (timing === "pre_tool_use" || timing === "post_tool_use") return "tool.call";
  return `policy.${timing}`;
}

function resolveResource(reg: PolicyRegistration, ctx: PolicyContext): string {
  return ctx.resource ?? ctx.toolName ?? reg.name;
}

function resolveEventReason(decision: PolicyDecision): string {
  if (decision.reason) return decision.reason;
  if (decision.verdict.reason) return decision.verdict.reason;
  return decision.verdict.action === "continue" ? "continue" : "unspecified";
}

function toEventVerdict(action: PolicyVerdict["action"]): EventVerdict {
  if (action === "deny") return "abort";
  return action;
}

function createActionId(
  sessionId: string,
  timing: Policy.Timing,
  label: string,
  sequence: number,
): string {
  return `${sessionId}:policy.${timing}:${label}:${sequence}`;
}

async function readNextSequence(sessionId: string): Promise<number> {
  let maxSequence = 0;
  for await (const event of EventLog.replay(sessionId)) {
    maxSequence = Math.max(maxSequence, event.sequence);
  }
  return maxSequence + 1;
}

function matchesPattern(resource: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return resource.startsWith(`${pattern.slice(0, -2)}.`);
  return resource === pattern;
}

// reject patterns with obvious backtracking risks: nested quantifiers like (a+)+, (a*)*
const BACKTRACK_RISK = /([+*]|\{\d)[+*?]|\([^)]*[+*][^)]*\)[+*]/;

function matchesInputField(
  input: Record<string, unknown> | undefined,
  field: string,
  pattern: string,
): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;
  if (BACKTRACK_RISK.test(pattern)) return false;

  const raw = String(input?.[field] ?? "");
  const value = raw.length > MAX_INPUT_LENGTH ? raw.slice(0, MAX_INPUT_LENGTH) : raw;

  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function permissionVerdict(
  decision: Policy.PermissionDecision,
  reason: string,
  matchedPattern?: string,
): Guardrail.EvaluationResult {
  const action: Extract<Guardrail.EvaluationResult["action"], "continue" | "abort"> =
    decision === "allow" ? "continue" : "abort";
  return matchedPattern === undefined
    ? { action, decision, reason, policyId: POLICY_ID }
    : { action, decision, reason, policyId: POLICY_ID, matchedPattern };
}

function evaluatePermission(
  permission: Policy.Permission | undefined,
  request: Policy.EvaluationRequest,
): Guardrail.EvaluationResult {
  if (!permission) return permissionVerdict("allow", "default_allow");
  if (permission.action !== request.action) return permissionVerdict("deny", "action_mismatch");

  const inputRules = [...(permission.inputRules ?? [])].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );

  for (const rule of inputRules) {
    if (
      matchesPattern(request.resource, rule.toolPattern) &&
      matchesInputField(request.input, rule.field, rule.pattern)
    ) {
      return permissionVerdict(
        rule.action,
        rule.reason ?? `input_rule_${rule.action}`,
        rule.toolPattern,
      );
    }
  }

  const deniedBy = permission.denylist?.find((pattern) =>
    matchesPattern(request.resource, pattern),
  );
  if (deniedBy) return permissionVerdict("deny", "denylist", deniedBy);

  const requiresApprovalBy = permission.requireApproval?.find((pattern) =>
    matchesPattern(request.resource, pattern),
  );
  if (requiresApprovalBy) {
    return permissionVerdict("require_approval", "require_approval", requiresApprovalBy);
  }

  if (permission.allowlist !== undefined) {
    const allowedBy = permission.allowlist.find((pattern) =>
      matchesPattern(request.resource, pattern),
    );

    if (allowedBy) return permissionVerdict("allow", "allowlist", allowedBy);

    return permissionVerdict(
      "deny",
      permission.allowlist.length === 0 ? "allowlist_empty" : "allowlist_miss",
    );
  }

  return permissionVerdict("allow", "default_allow");
}

function cloneRegistration(reg: PolicyRegistration): PolicyRegistration {
  return {
    ...reg,
    timing: Array.isArray(reg.timing) ? [...reg.timing] : reg.timing,
    ...(reg.scope !== undefined && {
      scope: {
        ...reg.scope,
        ...(reg.scope.agentType !== undefined && { agentType: [...reg.scope.agentType] }),
      },
    }),
  };
}

function create(options: PolicyEngineConfig = {}): PolicyEngineInstance {
  const registrations: PolicyRegistration[] = [];
  const warnedMissingMetadata = new Set<string>();
  const sequenceReservations = new Map<string, Promise<number>>();
  let frozen = false;

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

  function isAuditEnabled(): boolean {
    if (options.audit === false) return false;
    return options.audit?.enabled ?? true;
  }

  async function appendPolicyEvent(
    decision: PolicyDecision,
    reg: PolicyRegistration,
    ctx: PolicyContext,
  ): Promise<void> {
    if (!isAuditEnabled()) return;

    const audit = options.audit === false ? undefined : options.audit;
    const traceContext = decision.traceContext;
    const sessionId = audit?.sessionId ?? traceContext?.sessionId;
    if (!sessionId) return;

    const sequence = await reserveSequence(sessionId);
    await EventLog.append(sessionId, {
      type: "policy_evaluated",
      policyId: decision.policyId,
      actor: audit?.actor ?? ctx.actor ?? buildActor(traceContext),
      action: audit?.action ?? resolveAction(decision.timing, ctx),
      resource: audit?.resource ?? resolveResource(reg, ctx),
      verdict: toEventVerdict(decision.verdict.action),
      reason: resolveEventReason(decision),
      actionId: createActionId(sessionId, decision.timing, decision.label, sequence),
      ...(audit?.parentActionId !== undefined && { parentActionId: audit.parentActionId }),
      visibility: audit?.visibility ?? "internal",
      timestamp: new Date().toISOString(),
      sequence,
    });
  }

  async function recordDecision(
    reg: PolicyRegistration,
    ctx: PolicyContext,
    verdict: PolicyVerdict,
    durationMs: number,
  ): Promise<PolicyVerdict> {
    const normalized = normalizeVerdict(verdict, ctx.timing, reg.name, warnedMissingMetadata);
    const traceContext = ctx.traceContext ?? options.traceContext;
    const decision: PolicyDecision = {
      timing: ctx.timing,
      label: reg.name,
      policyId: normalized.policyId ?? "unknown",
      verdict: normalized,
      durationMs,
      ...(normalized.reason !== undefined && { reason: normalized.reason }),
      ...(traceContext !== undefined && { traceContext }),
      ...(ctx.envelope !== undefined && { envelope: ctx.envelope }),
    };

    await appendPolicyEvent(decision, reg, ctx);
    await options.onDecision?.(decision);
    return normalized;
  }

  async function dispatch<T = unknown>(
    timing: Policy.Timing,
    ctx: Omit<PolicyContext<T>, "timing">,
  ): Promise<PolicyVerdict> {
    const selected = selectRegistrations(registrations, timing, ctx.agentType);
    const fullCtx = { ...ctx, timing } as PolicyContext<T>;

    for (const reg of selected) {
      let verdict: PolicyVerdict;
      const startTime = Date.now();
      try {
        verdict = await reg.fn(fullCtx);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const failPolicy = reg.failPolicy ?? "fail-open";
        Log.warn("policy error", {
          timing,
          name: reg.name,
          error: String(err),
          failPolicy,
          durationMs,
        });
        if (failPolicy === "fail-closed") {
          return recordDecision(
            reg,
            fullCtx,
            { action: "abort", reason: "policy-error", policyId: reg.name },
            durationMs,
          );
        }
        continue;
      }

      const durationMs = Date.now() - startTime;
      verdict = await recordDecision(reg, fullCtx, verdict, durationMs);
      Log.debug("policy dispatch", {
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

  async function dispatchSystemPrompt<T = unknown>(
    ctx: Omit<PolicyContext<T>, "timing">,
  ): Promise<PolicySystemPromptVerdict> {
    const selected = selectRegistrations(registrations, "on_system_prompt", ctx.agentType);
    const fullCtx = { ...ctx, timing: "on_system_prompt" } as PolicyContext<T>;

    let systemPrompt: string | undefined;
    const prependParts: string[] = [];
    const appendParts: string[] = [];

    for (const reg of selected) {
      let verdict: PolicyVerdict;
      const startTime = Date.now();
      try {
        verdict = await reg.fn(fullCtx);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const failPolicy = reg.failPolicy ?? "fail-open";
        Log.warn("policy error", {
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
      Log.debug("policy dispatch", {
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

    const result: PolicySystemPromptVerdict = {};
    if (systemPrompt !== undefined) result.systemPrompt = systemPrompt;
    if (prependParts.length > 0) result.prependContext = prependParts.join("\n\n");
    if (appendParts.length > 0) result.appendContext = appendParts.join("\n\n");
    return result;
  }

  const instance: PolicyEngineInstance = {
    register(policy) {
      if (frozen) {
        throw new Error("PolicyEngine is frozen; register() cannot be called after freeze()");
      }
      registrations.push(policy as PolicyRegistration);
      return instance;
    },
    freeze() {
      frozen = true;
      return instance;
    },
    dispatch,
    dispatchSystemPrompt,
    evaluatePermission,
    deriveChildPolicies() {
      return registrations.filter((reg) => reg.propagate === true).map(cloneRegistration);
    },
  };

  return instance;
}

export const PolicyEngine = { create, evaluatePermission };
