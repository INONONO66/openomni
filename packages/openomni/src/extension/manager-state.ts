import type { Extension } from "@openomni/protocol";
import { appendAuditEvent, auditEventsForSession } from "./manager-audit";
import {
  lifecycleNames,
  LifecyclePayloadSchema,
  type AuditBusEvent,
  type AuditEvent,
  type AuditState,
  type ExtensionAuditEntry,
  type ExtensionLifecycleAuditEntry,
  type ExtensionManagerEntry,
  type ExtensionOperationAuditEntry,
  type LifecycleEventName,
  type LifecyclePayload,
  type ReconstructedState,
} from "./manager-types";

export async function appendLifecycleEvent(
  state: AuditState,
  name: LifecycleEventName,
  payload: LifecyclePayload,
): Promise<ExtensionManagerEntry> {
  const parsed = LifecyclePayloadSchema.parse(payload);
  await appendAuditEvent(
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

  return lifecycleEntry(parsed);
}

export async function reconstructState(sessionId: string): Promise<ReconstructedState> {
  const current = new Map<string, ExtensionManagerEntry>();
  const versions = new Map<string, ExtensionManagerEntry>();
  const installedVersions = new Map<string, string[]>();
  const audit: ExtensionAuditEntry[] = [];

  for (const event of auditEventsForSession(sessionId)) {
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

    const entry = lifecycleEntry(parsed.data);
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

export function resolveEntry(
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

export function stateKey(extensionId: string, version: string): string {
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

function lifecycleEntry(payload: LifecyclePayload): ExtensionManagerEntry {
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

function isLifecycleName(name: string): name is LifecycleEventName {
  return lifecycleNames.has(name as LifecycleEventName);
}
