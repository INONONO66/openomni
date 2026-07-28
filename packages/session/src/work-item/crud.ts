import { WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Storage } from "../storage/storage.js";
import { detectCycles } from "./dependency.js";
import { persistMutation } from "./mutation.js";
import type { WorkItemListFilter } from "./types.js";

export function getWorkItem(hash: string): WorkItem.Info | undefined {
  return Storage.get().workItem?.get(hash);
}

export function listWorkItems(filter?: WorkItemListFilter): WorkItem.Info[] {
  return Storage.get().workItem?.list(filter) ?? [];
}

export function removeWorkItem(hash: string): boolean {
  const adapter = Storage.get();
  if (!adapter.workItem) return false;

  const existing = adapter.workItem.get(hash);
  if (!existing) return false;

  if (existing.relations.parentHash) {
    const parent = adapter.workItem.get(existing.relations.parentHash);
    if (parent) {
      const filtered = parent.relations.childHashes.filter((h) => h !== hash);
      if (filtered.length !== parent.relations.childHashes.length) {
        adapter.workItem.set(parent.hash, {
          ...parent,
          relations: { ...parent.relations, childHashes: filtered },
          timestamps: { ...parent.timestamps, updated: Date.now() },
        });
      }
    }
  }

  for (const item of adapter.workItem.list()) {
    if (item.relations.dependsOn.includes(hash)) {
      adapter.workItem.set(item.hash, {
        ...item,
        relations: {
          ...item.relations,
          dependsOn: item.relations.dependsOn.filter((h) => h !== hash),
        },
        timestamps: { ...item.timestamps, updated: Date.now() },
      });
    }
  }

  const removed = adapter.workItem.remove(hash);
  if (removed) {
    Bus.publish(WorkItem.Events.Removed, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      sessionId: existing.sessionId,
      payload: { hash, sessionId: existing.sessionId },
    });
  }
  return removed;
}

export async function updateWorkItem(
  hash: string,
  fields: Partial<Omit<WorkItem.Info, "hash">>,
): Promise<WorkItem.Info | undefined> {
  const adapter = Storage.get();
  if (!adapter.workItem) return undefined;

  const existing = adapter.workItem.get(hash);
  if (!existing) return undefined;

  const managedFields = [
    "timestamps",
    "failureReason",
    "attempt",
    "blockers",
    "evidence",
    "completionReport",
    "verificationGate",
    "outcome",
  ] as const;
  for (const key of managedFields) {
    if (key in fields) {
      throw new Error(`Use lifecycle helpers instead of update() for "${key}"`);
    }
  }
  if (fields.relations) {
    const r = fields.relations as Record<string, unknown>;
    if (r.parentHash !== undefined) {
      throw new Error("Cannot change parentHash after creation — create a new work item instead");
    }
    if (fields.relations.dependsOn) {
      detectCycles(adapter.workItem, fields.relations.dependsOn, new Set([hash]));
    }
  }

  const now = Date.now();
  const updated: WorkItem.Info = {
    ...existing,
    ...fields,
    hash,
    timestamps: {
      ...existing.timestamps,
      ...(fields.timestamps ?? {}),
      updated: now,
    },
    relations: {
      ...existing.relations,
      ...(fields.relations ?? {}),
      parentHash: existing.relations.parentHash,
      childHashes: existing.relations.childHashes,
    },
  };

  return persistMutation(adapter.workItem, existing, updated, now, Object.keys(fields));
}
