import { Policy } from "@openomni/protocol";
import { Storage, createAuditLog } from "@openomni/session";
import { actorKind, truncateAuditText } from "./audit-util";
import type { ExtensionManifestSummary } from "./manager-manifest";
import {
  AUDIT_VISIBILITY,
  AUTHORITY_REQUIRED_REASON,
  authorityActions,
  authorityActorKinds,
  type AuditActionApproved,
  type AuditActionBlocked,
  type AuditActionRequested,
  type AuditEvent,
  type AuditPolicyEvaluated,
  type AuditState,
  type AuditVisibility,
  type ExtensionAction,
  type ExtensionOperationOptions,
} from "./manager-types";

const auditEventsBySession = new Map<string, AuditEvent[]>();

export async function beginOperation(
  options: ExtensionOperationOptions,
  request: {
    readonly action: ExtensionAction;
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
  const evaluationRequest: Policy.EvaluationRequest = {
    action: request.action,
    resource: request.resource,
    input: policyInput(request.input, options.actor),
    actor: options.actor,
  };

  const authorityResult = Policy.evaluate(
    extensionAuthorityPermission(request.action),
    evaluationRequest,
  );
  if (authorityActions.has(request.action)) {
    await appendPolicyEvent(state, authorityResult);
    if (authorityResult.action === "abort") {
      await blockOperation(
        state,
        authorityResult.policyId,
        authorityResult.reason,
        canonicalVerdict(authorityResult),
      );
      throw new Error(
        `Extension operation "${request.action}" on "${request.resource}" denied: ${authorityResult.reason}`,
      );
    }
  }

  const result = Policy.evaluate(options.permission, evaluationRequest);

  await appendPolicyEvent(state, result);
  if (result.action === "abort") {
    await blockOperation(state, result.policyId, result.reason, canonicalVerdict(result));
    throw new Error(
      `Extension operation "${request.action}" on "${request.resource}" denied: ${result.reason}`,
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
      policyId: "extension.manager",
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

export async function appendAuditEvent<T extends AuditEvent>(
  sessionId: string,
  eventType: T["type"],
  event: (base: {
    readonly actionId: string;
    readonly parentActionId?: string;
    readonly visibility: AuditVisibility;
    readonly timestamp: string;
    readonly sequence: number;
  }) => T,
  now: () => Date,
  parentActionId?: string,
): Promise<T> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const actionId = `${sessionId}:${eventType}:extension:${suffix}`;
  const row = event({
    actionId,
    ...(parentActionId !== undefined ? { parentActionId } : {}),
    visibility: AUDIT_VISIBILITY,
    timestamp: now().toISOString(),
    sequence: 0,
  });

  createAuditLog(sessionId, "extension.manager").append(
    eventType,
    row as unknown as Record<string, unknown>,
    parentActionId,
  );
  const events = auditEventsBySession.get(sessionId) ?? [];
  events.push(row);
  auditEventsBySession.set(sessionId, events);
  return row;
}

export function auditEventsForSession(sessionId: string): readonly AuditEvent[] {
  return auditEventsBySession.get(sessionId) ?? [];
}

export function operationInput(input: {
  readonly id?: string;
  readonly version?: string;
  readonly toVersion?: string;
  readonly reason?: string;
  readonly manifest?: ExtensionManifestSummary;
}): Record<string, unknown> {
  return {
    ...(input.id !== undefined ? { id: truncateAuditText(input.id) } : {}),
    ...(input.version !== undefined ? { version: truncateAuditText(input.version) } : {}),
    ...(input.toVersion !== undefined ? { toVersion: truncateAuditText(input.toVersion) } : {}),
    ...(input.reason !== undefined ? { reason: truncateAuditText(input.reason) } : {}),
    ...(input.manifest !== undefined ? { manifest: input.manifest } : {}),
  };
}

function extensionAuthorityPermission(action: ExtensionAction): Policy.Permission | undefined {
  if (!authorityActions.has(action)) {
    return undefined;
  }

  return {
    action,
    allowlist: ["*"],
    inputRules: [
      {
        toolPattern: "*",
        field: "actorKind",
        pattern: `^(?!(?:${authorityActorKinds.join("|")})$).*$`,
        action: "deny",
        reason: AUTHORITY_REQUIRED_REASON,
        priority: 100,
      },
    ],
  };
}

function policyInput(
  input: Record<string, unknown>,
  actor: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...input,
    actorKind: actorKind(actor),
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

function requireAuditSession(options: ExtensionOperationOptions): string {
  const sessionId = options.audit?.sessionId;
  if (!sessionId) {
    throw new Error("ExtensionManager operations require audit.sessionId");
  }

  const adapter = Storage.get();
  if (!adapter.session.get(sessionId)) {
    throw new Error(`Audit session "${sessionId}" not found for extension operation`);
  }

  return sessionId;
}
