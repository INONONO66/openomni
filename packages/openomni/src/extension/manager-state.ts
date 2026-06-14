import type { Extension } from "@openomni/protocol";
import { appendAuditEvent, auditEventsForSession } from "./manager-audit";
import {
  lifecycleNames,
  LifecyclePayloadSchema,
  type AuditBusEvent,
  type AuditState,
  type ExtensionManagerEntry,
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

  for (const event of auditEventsForSession(sessionId)) {
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
  }

  return { current, versions };
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
