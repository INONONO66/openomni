import { Policy } from "@openomni/protocol";
import { AuditLog, Storage } from "@openomni/session";
import type { SkillOperationOptions } from "./manager";

export type SkillAction =
  | "skill.install"
  | "skill.enable"
  | "skill.disable"
  | "skill.uninstall"
  | "skill.list";

type AuditVisibility = "internal" | "llm_reason" | "user_audit";

interface AuditBase {
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly visibility: AuditVisibility;
  readonly timestamp: string;
}

interface AuditActionRequested extends AuditBase {
  readonly type: "action_requested";
  readonly actor: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly input?: Record<string, unknown>;
}

interface AuditPolicyEvaluated extends AuditBase {
  readonly type: "policy_evaluated";
  readonly policyId: string;
  readonly actor: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly verdict: Policy.PolicyDecision["verdict"];
  readonly reason: string;
}

interface AuditActionApproved extends AuditBase {
  readonly type: "action_approved";
  readonly policyId: string;
  readonly actor: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly verdict: "allow";
  readonly reason: string;
}

interface AuditActionBlocked extends AuditBase {
  readonly type: "action_blocked";
  readonly policyId: string;
  readonly actor: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly verdict: Policy.PolicyDecision["verdict"];
  readonly reason: string;
}

type AuditEvent =
  | AuditActionRequested
  | AuditPolicyEvaluated
  | AuditActionApproved
  | AuditActionBlocked;

export interface AuditState {
  readonly sessionId: string;
  readonly actor: Record<string, unknown>;
  readonly action: SkillAction;
  readonly resource: string;
  readonly input: Record<string, unknown>;
  readonly parentActionId?: string;
  readonly now: () => Date;
}

const AUDIT_VISIBILITY: AuditVisibility = "internal";
const MAX_AUDIT_TEXT_LENGTH = 256;

export async function beginOperation(
  options: SkillOperationOptions,
  request: {
    readonly action: SkillAction;
    readonly resource: string;
    readonly input: Record<string, unknown>;
  },
): Promise<AuditState> {
  const sessionId = requireAuditSession(options);
  const now = options.now ?? (() => new Date());
  const requested = await appendAuditEvent(
    sessionId,
    "action_requested",
    (base): AuditActionRequested => ({
      type: "action_requested",
      actor: options.actor,
      action: request.action,
      resource: request.resource,
      input: request.input,
      ...base,
    }),
    now,
  );

  const state: AuditState = {
    sessionId,
    actor: options.actor,
    action: request.action,
    resource: request.resource,
    input: request.input,
    parentActionId: requested.actionId,
    now,
  };
  const result = Policy.evaluate(options.permission, {
    action: request.action,
    resource: request.resource,
    input: request.input,
    actor: options.actor,
  });

  await appendPolicyEvent(state, result);
  if (result.action === "abort") {
    await blockOperation(state, result.policyId, result.reason, canonicalVerdict(result));
    throw new Error(
      `Skill operation "${request.action}" on "${request.resource}" denied: ${result.reason}`,
    );
  }

  return state;
}

export async function approveOperation(state: AuditState, reason: string): Promise<void> {
  await appendAuditEvent(
    state.sessionId,
    "action_approved",
    (base): AuditActionApproved => ({
      type: "action_approved",
      policyId: "skill.manager",
      actor: state.actor,
      action: state.action,
      resource: state.resource,
      verdict: "allow",
      reason,
      ...base,
    }),
    state.now,
    state.parentActionId,
  );
}

export async function blockOperation(
  state: AuditState,
  policyId: string,
  reason: string,
  verdict: AuditActionBlocked["verdict"] = "deny",
): Promise<void> {
  await appendAuditEvent(
    state.sessionId,
    "action_blocked",
    (base): AuditActionBlocked => ({
      type: "action_blocked",
      policyId,
      actor: state.actor,
      action: state.action,
      resource: state.resource,
      verdict,
      reason,
      ...base,
    }),
    state.now,
    state.parentActionId,
  );
}

export function operationInput(input: {
  readonly id?: string;
  readonly scope?: string;
  readonly source?: string;
  readonly enabled?: boolean;
  readonly version?: string;
}): Record<string, unknown> {
  return {
    ...(input.id !== undefined ? { id: truncateAuditText(input.id) } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}),
    ...(input.source !== undefined ? { source: truncateAuditText(input.source) } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.version !== undefined ? { version: truncateAuditText(input.version) } : {}),
  };
}

function canonicalVerdict(result: Policy.EvaluationResult): Policy.PolicyDecision["verdict"] {
  if (result.decision === "require_approval") return "pending";
  return result.action === "continue" ? "allow" : "deny";
}

async function appendPolicyEvent(
  state: AuditState,
  result: Policy.EvaluationResult,
): Promise<void> {
  await appendAuditEvent(
    state.sessionId,
    "policy_evaluated",
    (base): AuditPolicyEvaluated => ({
      type: "policy_evaluated",
      policyId: result.policyId,
      actor: state.actor,
      action: state.action,
      resource: state.resource,
      verdict: canonicalVerdict(result),
      reason: result.reason,
      ...base,
    }),
    state.now,
    state.parentActionId,
  );
}

async function appendAuditEvent<T extends AuditEvent>(
  sessionId: string,
  eventType: T["type"],
  event: (base: {
    readonly actionId: string;
    readonly parentActionId?: string;
    readonly visibility: AuditVisibility;
    readonly timestamp: string;
  }) => T,
  now: () => Date,
  parentActionId?: string,
): Promise<T> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const actionId = `${sessionId}:${eventType}:skill:${suffix}`;
  const row = event({
    actionId,
    ...(parentActionId !== undefined ? { parentActionId } : {}),
    visibility: AUDIT_VISIBILITY,
    timestamp: now().toISOString(),
  });

  AuditLog.create(sessionId, "skill.manager").append(
    eventType,
    row as unknown as Record<string, unknown>,
    parentActionId,
  );
  return row;
}

function requireAuditSession(options: SkillOperationOptions): string {
  const sessionId = options.audit?.sessionId;
  if (!sessionId) {
    throw new Error("SkillManager operations require audit.sessionId");
  }

  const adapter = Storage.get();
  if (!adapter.session.get(sessionId)) {
    throw new Error(`Audit session "${sessionId}" not found for skill operation`);
  }

  return sessionId;
}

function truncateAuditText(value: string): string {
  return value.length <= MAX_AUDIT_TEXT_LENGTH ? value : value.slice(0, MAX_AUDIT_TEXT_LENGTH);
}
