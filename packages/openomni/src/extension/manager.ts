import { Extension, Policy, Operational } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";
import { z } from "zod";
import { actorKind, actorLabel, errorMessage, truncateAuditText } from "./audit-util";
import {
  AuditManifestSummarySchema,
  auditManifestSummary,
  auditValidationInput,
  auditValidationResource,
  parseExtensionManifest,
} from "./manager-manifest";
import type { ExtensionManifestSummary, ExtensionValidationResult } from "./manager-manifest";
import type { RuntimeBindingController, RuntimeBindingExtension } from "./runtime-binding";

export type {
  ExtensionManifestSummary,
  ExtensionValidationFailure,
  ExtensionValidationResult,
  ExtensionValidationSuccess,
} from "./manager-manifest";

type ExtensionAction =
  | "extension.validate"
  | "extension.requestInstall"
  | "extension.approve"
  | "extension.install"
  | "extension.enable"
  | "extension.disable"
  | "extension.rollback"
  | "extension.list"
  | "extension.audit";

type AuditVisibility = "internal" | "llm_reason" | "user_audit";
type AuditOperationType =
  | "action_requested"
  | "policy_evaluated"
  | "action_approved"
  | "action_blocked";

interface AuditBase {
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly visibility: AuditVisibility;
  readonly timestamp: string;
  readonly sequence: number;
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

interface AuditBusEvent extends AuditBase {
  readonly type: "bus_event";
  readonly name: string;
  readonly payload: unknown;
}

type AuditEvent =
  | AuditActionRequested
  | AuditPolicyEvaluated
  | AuditActionApproved
  | AuditActionBlocked
  | AuditBusEvent;

type LifecycleEventName =
  | "extension.proposed"
  | "extension.approved"
  | "extension.installed"
  | "extension.enabled"
  | "extension.disabled"
  | "extension.rolled_back"
  | "extension.failed";

interface AuditState {
  readonly sessionId: string;
  readonly actor: Record<string, unknown>;
  readonly action: ExtensionAction;
  readonly resource: string;
  readonly input: Record<string, unknown>;
  readonly parentActionId?: string;
  readonly now: () => Date;
}

interface ReconstructedState {
  readonly current: Map<string, ExtensionManagerEntry>;
  readonly versions: Map<string, ExtensionManagerEntry>;
  readonly installedVersions: Map<string, string[]>;
  readonly audit: ExtensionAuditEntry[];
}

export interface ExtensionAuditContext {
  readonly sessionId: string;
}

export interface ExtensionOperationOptions {
  readonly actor: Record<string, unknown>;
  readonly audit: ExtensionAuditContext;
  readonly permission?: Policy.Permission;
  readonly now?: () => Date;
}

export interface ExtensionRequestInstallOptions extends ExtensionOperationOptions {
  readonly reason?: string;
}

export interface ExtensionVersionOperationOptions extends ExtensionOperationOptions {
  readonly version?: string;
  readonly reason?: string;
}

export interface ExtensionBindingOperationOptions extends ExtensionVersionOperationOptions {
  readonly binding?: RuntimeBindingController;
}

export interface ExtensionRollbackOptions extends ExtensionOperationOptions {
  readonly version?: string;
  readonly toVersion?: string;
  readonly reason?: string;
}

export interface ExtensionListOptions extends ExtensionOperationOptions {
  readonly extensionId?: string;
}

export interface ExtensionAuditOptions extends ExtensionOperationOptions {
  readonly extensionId?: string;
}

export interface ExtensionManagerEntry {
  readonly id: string;
  readonly version: string;
  readonly state: Extension.LifecycleState;
  readonly actor: string;
  readonly updatedAt: number;
  readonly reason?: string;
  readonly fromVersion?: string;
  readonly manifest?: ExtensionManifestSummary;
  readonly error?: string;
}

export interface ExtensionLifecycleAuditEntry {
  readonly kind: "lifecycle";
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly visibility: AuditVisibility;
  readonly timestamp: string;
  readonly sequence: number;
  readonly name: LifecycleEventName;
  readonly extensionId: string;
  readonly version: string;
  readonly state: Extension.LifecycleState;
  readonly actor: string;
  readonly time: number;
  readonly reason?: string;
  readonly fromVersion?: string;
  readonly manifest?: ExtensionManifestSummary;
  readonly error?: string;
}

export interface ExtensionOperationAuditEntry {
  readonly kind: "operation";
  readonly actionId: string;
  readonly parentActionId?: string;
  readonly visibility: AuditVisibility;
  readonly timestamp: string;
  readonly sequence: number;
  readonly type: AuditOperationType;
  readonly actor: Record<string, unknown>;
  readonly action: string;
  readonly resource: string;
  readonly input?: Record<string, unknown>;
  readonly policyId?: string;
  readonly verdict?: string;
  readonly reason?: string;
}

export type ExtensionAuditEntry = ExtensionLifecycleAuditEntry | ExtensionOperationAuditEntry;

const AUDIT_VISIBILITY: AuditVisibility = "internal";
const AUTHORITY_REQUIRED_REASON = "extension_authority_requires_user_main_or_trusted_manager";
const authorityActorKinds: readonly string[] = ["user", "main", "trusted_manager"];
const authorityActions = new Set<ExtensionAction>(["extension.approve", "extension.enable"]);

const lifecycleNames = new Set<LifecycleEventName>([
  "extension.proposed",
  "extension.approved",
  "extension.installed",
  "extension.enabled",
  "extension.disabled",
  "extension.rolled_back",
  "extension.failed",
]);

const LifecyclePayloadSchema = z.object({
  extensionId: z.string(),
  version: z.string(),
  actor: z.string(),
  time: z.number(),
  reason: z.string().optional(),
  state: Extension.LifecycleState,
  fromVersion: z.string().optional(),
  manifest: AuditManifestSummarySchema.optional(),
  error: z.string().optional(),
});

type LifecyclePayload = z.infer<typeof LifecyclePayloadSchema>;

export namespace ExtensionManager {
  export async function validate(
    manifest: unknown,
    options: ExtensionOperationOptions,
  ): Promise<ExtensionValidationResult> {
    const operation = await beginOperation(options, {
      action: "extension.validate",
      resource: auditValidationResource(manifest),
      input: auditValidationInput(manifest),
    });
    const result = parseExtensionManifest(manifest);

    await approveOperation(
      operation,
      result.success
        ? "extension manifest validation passed"
        : "extension manifest validation failed",
    );
    return result;
  }

  export async function requestInstall(
    manifest: unknown,
    options: ExtensionRequestInstallOptions,
  ): Promise<ExtensionManagerEntry> {
    const parsed = parseExtensionManifest(manifest);
    if (!parsed.success) {
      throw new Error(`Invalid extension manifest: ${parsed.errors.join("; ")}`);
    }

    const input = operationInput({
      id: parsed.manifest.id,
      version: parsed.manifest.version,
      reason: options.reason,
      manifest: auditManifestSummary(parsed.manifest),
    });
    const operation = await beginOperation(options, {
      action: "extension.requestInstall",
      resource: parsed.manifest.id,
      input,
    });
    const state = await reconstructState(operation.sessionId);
    const existing = state.versions.get(stateKey(parsed.manifest.id, parsed.manifest.version));
    if (existing && existing.state !== "failed" && existing.state !== "rolled_back") {
      await blockOperation(
        operation,
        "extension.manager.lifecycle",
        "extension_version_already_requested",
      );
      throw new Error(
        `Extension "${parsed.manifest.id}" version "${parsed.manifest.version}" is already ${existing.state}`,
      );
    }

    await approveOperation(operation, "extension install request approved");
    return appendLifecycleEvent(operation, "extension.proposed", {
      extensionId: parsed.manifest.id,
      version: parsed.manifest.version,
      actor: actorLabel(options.actor),
      time: operation.now().getTime(),
      state: "proposed",
      ...(options.reason !== undefined ? { reason: truncateAuditText(options.reason) } : {}),
      manifest: auditManifestSummary(parsed.manifest, { includeComponents: true }),
    });
  }

  export async function approve(
    extensionId: string,
    options: ExtensionVersionOperationOptions,
  ): Promise<ExtensionManagerEntry> {
    return transition(extensionId, options, {
      action: "extension.approve",
      eventName: "extension.approved",
      nextState: "approved",
      allowedStates: ["proposed"],
      approvalReason: "extension approval accepted",
    });
  }

  export async function install(
    extensionId: string,
    options: ExtensionVersionOperationOptions,
  ): Promise<ExtensionManagerEntry> {
    return transition(extensionId, options, {
      action: "extension.install",
      eventName: "extension.installed",
      nextState: "installed",
      allowedStates: ["approved"],
      approvalReason: "extension install accepted",
    });
  }

  export async function enable(
    extensionId: string,
    options: ExtensionBindingOperationOptions,
  ): Promise<ExtensionManagerEntry> {
    return transition(extensionId, options, {
      action: "extension.enable",
      eventName: "extension.enabled",
      nextState: "enabled",
      allowedStates: ["installed", "disabled"],
      approvalReason: "extension enable accepted",
      binding: options.binding,
      bindingAction: "enable",
    });
  }

  export async function disable(
    extensionId: string,
    options: ExtensionBindingOperationOptions,
  ): Promise<ExtensionManagerEntry> {
    return transition(extensionId, options, {
      action: "extension.disable",
      eventName: "extension.disabled",
      nextState: "disabled",
      allowedStates: ["enabled"],
      approvalReason: "extension disable accepted",
      binding: options.binding,
      bindingAction: "disable",
    });
  }

  export async function rollback(
    extensionId: string,
    options: ExtensionRollbackOptions,
  ): Promise<ExtensionManagerEntry> {
    const input = operationInput({
      id: extensionId,
      version: options.version,
      toVersion: options.toVersion,
      reason: options.reason,
    });
    const operation = await beginOperation(options, {
      action: "extension.rollback",
      resource: extensionId,
      input,
    });
    const state = await reconstructState(operation.sessionId);
    const source = resolveEntry(state, extensionId, options.version, [
      "installed",
      "enabled",
      "disabled",
    ]);
    if (!source) {
      await blockOperation(operation, "extension.manager.lifecycle", "extension_not_rollbackable");
      throw new Error(
        `Extension "${extensionId}" has no installed, enabled, or disabled version to roll back`,
      );
    }

    const targetVersion = resolveRollbackTarget(
      state,
      extensionId,
      source.version,
      options.toVersion,
    );
    if (!targetVersion) {
      await blockOperation(
        operation,
        "extension.manager.lifecycle",
        "extension_previous_version_missing",
      );
      throw new Error(`Extension "${extensionId}" has no previous version to roll back to`);
    }

    await approveOperation(operation, "extension rollback accepted");
    return appendLifecycleEvent(operation, "extension.rolled_back", {
      extensionId,
      version: targetVersion,
      actor: actorLabel(options.actor),
      time: operation.now().getTime(),
      state: "rolled_back",
      fromVersion: source.version,
      ...(options.reason !== undefined ? { reason: truncateAuditText(options.reason) } : {}),
      manifest: state.versions.get(stateKey(extensionId, targetVersion))?.manifest,
    });
  }

  export async function list(options: ExtensionListOptions): Promise<ExtensionManagerEntry[]> {
    const resource = options.extensionId ?? "all";
    const operation = await beginOperation(options, {
      action: "extension.list",
      resource,
      input: operationInput({ id: options.extensionId }),
    });
    const state = await reconstructState(operation.sessionId);
    const entries = sortEntries([...state.current.values()]).filter(
      (entry) => options.extensionId === undefined || entry.id === options.extensionId,
    );

    await approveOperation(operation, "extension list accepted");
    return entries;
  }

  export async function audit(options: ExtensionAuditOptions): Promise<ExtensionAuditEntry[]> {
    const resource = options.extensionId ?? "all";
    const operation = await beginOperation(options, {
      action: "extension.audit",
      resource,
      input: operationInput({ id: options.extensionId }),
    });
    const state = await reconstructState(operation.sessionId);
    const entries = state.audit.filter(
      (entry) =>
        options.extensionId === undefined ||
        (entry.kind === "lifecycle"
          ? entry.extensionId === options.extensionId
          : entry.resource === options.extensionId),
    );

    await approveOperation(operation, "extension audit accepted");
    return entries;
  }
}

interface TransitionConfig {
  readonly action: Extract<
    ExtensionAction,
    "extension.approve" | "extension.install" | "extension.enable" | "extension.disable"
  >;
  readonly eventName: LifecycleEventName;
  readonly nextState: Extension.LifecycleState;
  readonly allowedStates: readonly Extension.LifecycleState[];
  readonly approvalReason: string;
  readonly binding?: RuntimeBindingController;
  readonly bindingAction?: "enable" | "disable";
}

async function transition(
  extensionId: string,
  options: ExtensionVersionOperationOptions,
  config: TransitionConfig,
): Promise<ExtensionManagerEntry> {
  const operation = await beginOperation(options, {
    action: config.action,
    resource: extensionId,
    input: operationInput({ id: extensionId, version: options.version, reason: options.reason }),
  });
  const state = await reconstructState(operation.sessionId);
  const current = resolveEntry(state, extensionId, options.version, config.allowedStates);
  if (!current) {
    await blockOperation(operation, "extension.manager.lifecycle", "invalid_lifecycle_transition");
    throw new Error(
      `Extension "${extensionId}"${options.version ? ` version "${options.version}"` : ""} cannot ${config.action.replace("extension.", "")} from its current state`,
    );
  }

  await approveOperation(operation, config.approvalReason);
  const payload: LifecyclePayload = {
    extensionId,
    version: current.version,
    actor: actorLabel(options.actor),
    time: operation.now().getTime(),
    state: config.nextState,
    ...(options.reason !== undefined ? { reason: truncateAuditText(options.reason) } : {}),
    ...(current.manifest !== undefined ? { manifest: current.manifest } : {}),
  };

  if (config.binding && config.bindingAction) {
    try {
      await runBinding(config.binding, config.bindingAction, current);
    } catch (error) {
      await appendLifecycleEvent(operation, "extension.failed", {
        extensionId,
        version: current.version,
        actor: actorLabel(options.actor),
        time: operation.now().getTime(),
        state: "failed",
        reason: "runtime_binding_failed",
        error: truncateAuditText(errorMessage(error)),
        ...(current.manifest !== undefined ? { manifest: current.manifest } : {}),
      });
      throw new Error(`Extension runtime binding failed: ${errorMessage(error)}`);
    }
  }

  return appendLifecycleEvent(operation, config.eventName, payload);
}

async function runBinding(
  binding: RuntimeBindingController,
  action: "enable" | "disable",
  entry: ExtensionManagerEntry,
): Promise<void> {
  const extension: RuntimeBindingExtension = {
    id: entry.id,
    version: entry.version,
    ...(entry.manifest?.components !== undefined ? { contributes: entry.manifest.components } : {}),
  };

  if (action === "enable") {
    await binding.enable(extension);
    return;
  }

  await binding.disable(extension);
}

async function beginOperation(
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

async function approveOperation(state: AuditState, reason: string): Promise<void> {
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

async function blockOperation(
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

async function appendLifecycleEvent(
  state: AuditState,
  name: LifecycleEventName,
  payload: LifecyclePayload,
): Promise<ExtensionManagerEntry> {
  const parsed = LifecyclePayloadSchema.parse(payload);
  const row = await appendAuditEvent(
    state.sessionId,
    "bus_event",
    (base): AuditBusEvent => ({
      type: "bus_event",
      name,
      payload: parsed,
      ...base,
    }),
    state.now,
    state.parentActionId,
  );

  return lifecycleEntry(name, row, parsed);
}

const auditSequences = new Map<string, number>();
const auditEventsBySession = new Map<string, AuditEvent[]>();

async function appendAuditEvent<T extends AuditEvent>(
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
  const prev = auditSequences.get(sessionId) ?? 0;
  const sequence = prev + 1;
  auditSequences.set(sessionId, sequence);
  const row = event({
    actionId: `${sessionId}:${eventType}:extension:${sequence}`,
    ...(parentActionId !== undefined ? { parentActionId } : {}),
    visibility: AUDIT_VISIBILITY,
    timestamp: now().toISOString(),
    sequence,
  });

  Bus.publish(Operational.Info, {
    traceId: sessionId,
    time: Date.now(),
    sessionId,
    component: "extension.manager",
    msg: eventType,
    context: { audit: row as unknown as Record<string, unknown> },
  });
  const events = auditEventsBySession.get(sessionId) ?? [];
  events.push(row);
  auditEventsBySession.set(sessionId, events);
  return row;
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

async function reconstructState(sessionId: string): Promise<ReconstructedState> {
  const current = new Map<string, ExtensionManagerEntry>();
  const versions = new Map<string, ExtensionManagerEntry>();
  const installedVersions = new Map<string, string[]>();
  const audit: ExtensionAuditEntry[] = [];

  for (const event of auditEventsBySession.get(sessionId) ?? []) {
    const operation = operationAuditEntry(event);
    if (operation) {
      audit.push(operation);
    }

    if (event.type !== "bus_event" || !isLifecycleName(event.name)) {
      continue;
    }

    const parsed = LifecyclePayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      continue;
    }

    const entry = lifecycleEntry(event.name, event, parsed.data);
    current.set(entry.id, entry);
    versions.set(stateKey(entry.id, entry.version), entry);
    audit.push(lifecycleAuditEntry(event.name, event, parsed.data));

    if (entry.state === "installed") {
      const installed = installedVersions.get(entry.id) ?? [];
      if (!installed.includes(entry.version)) {
        installed.push(entry.version);
      }
      installedVersions.set(entry.id, installed);
    }
  }

  return { current, versions, installedVersions, audit };
}

function operationAuditEntry(event: AuditEvent): ExtensionOperationAuditEntry | undefined {
  if (
    event.type !== "action_requested" &&
    event.type !== "policy_evaluated" &&
    event.type !== "action_approved" &&
    event.type !== "action_blocked"
  ) {
    return undefined;
  }
  if (!event.action.startsWith("extension.")) {
    return undefined;
  }

  return {
    kind: "operation",
    actionId: event.actionId,
    ...(event.parentActionId !== undefined ? { parentActionId: event.parentActionId } : {}),
    visibility: event.visibility,
    timestamp: event.timestamp,
    sequence: event.sequence,
    type: event.type,
    actor: event.actor,
    action: event.action,
    resource: event.resource,
    ...(event.type === "action_requested" && event.input !== undefined
      ? { input: event.input }
      : {}),
    ...(event.type !== "action_requested" ? { policyId: event.policyId } : {}),
    ...(event.type !== "action_requested" ? { verdict: event.verdict } : {}),
    ...(event.type !== "action_requested" ? { reason: event.reason } : {}),
  };
}

function lifecycleAuditEntry(
  name: LifecycleEventName,
  event: AuditBusEvent,
  payload: LifecyclePayload,
): ExtensionLifecycleAuditEntry {
  return {
    kind: "lifecycle",
    actionId: event.actionId,
    ...(event.parentActionId !== undefined ? { parentActionId: event.parentActionId } : {}),
    visibility: event.visibility,
    timestamp: event.timestamp,
    sequence: event.sequence,
    name,
    extensionId: payload.extensionId,
    version: payload.version,
    state: payload.state,
    actor: payload.actor,
    time: payload.time,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    ...(payload.fromVersion !== undefined ? { fromVersion: payload.fromVersion } : {}),
    ...(payload.manifest !== undefined ? { manifest: payload.manifest } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
  };
}

function lifecycleEntry(
  _name: LifecycleEventName,
  _event: AuditBusEvent,
  payload: LifecyclePayload,
): ExtensionManagerEntry {
  return {
    id: payload.extensionId,
    version: payload.version,
    state: payload.state,
    actor: payload.actor,
    updatedAt: payload.time,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    ...(payload.fromVersion !== undefined ? { fromVersion: payload.fromVersion } : {}),
    ...(payload.manifest !== undefined ? { manifest: payload.manifest } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
  };
}

function resolveEntry(
  state: ReconstructedState,
  extensionId: string,
  version: string | undefined,
  allowedStates: readonly Extension.LifecycleState[],
): ExtensionManagerEntry | undefined {
  if (version !== undefined) {
    const entry = state.versions.get(stateKey(extensionId, version));
    return entry && allowedStates.includes(entry.state) ? entry : undefined;
  }

  return sortEntries([...state.versions.values()].filter((entry) => entry.id === extensionId))
    .reverse()
    .find((entry) => allowedStates.includes(entry.state));
}

function resolveRollbackTarget(
  state: ReconstructedState,
  extensionId: string,
  fromVersion: string,
  requestedTarget: string | undefined,
): string | undefined {
  const installed = state.installedVersions.get(extensionId) ?? [];
  if (requestedTarget !== undefined) {
    return installed.includes(requestedTarget) && requestedTarget !== fromVersion
      ? requestedTarget
      : undefined;
  }

  return [...installed].reverse().find((version) => version !== fromVersion);
}

function operationInput(input: {
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

function isLifecycleName(name: string): name is LifecycleEventName {
  return lifecycleNames.has(name as LifecycleEventName);
}

function stateKey(extensionId: string, version: string): string {
  return `${extensionId}@${version}`;
}

function sortEntries(entries: readonly ExtensionManagerEntry[]): ExtensionManagerEntry[] {
  return [...entries].sort((a, b) => {
    const idComparison = a.id.localeCompare(b.id);
    if (idComparison !== 0) return idComparison;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    return a.version.localeCompare(b.version);
  });
}
