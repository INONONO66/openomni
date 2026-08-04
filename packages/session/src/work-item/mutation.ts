import { WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Storage } from "../storage/storage.js";
import type { WorkItemAdapter, WorkItemMutation, WorkItemTransitionTarget } from "./types.js";

class WorkItemRevisionError extends Error {
  readonly name = "WorkItemRevisionError";
  readonly code = "stale_revision";

  constructor(readonly hash: string) {
    super(`stale WorkItem revision: ${hash}`);
  }
}

export function mutateTimestamps(
  hash: string,
  target: "started" | "cancelled",
  updateTimestamps: (
    timestamps: WorkItem.Info["timestamps"],
    now: number,
  ) => WorkItem.Info["timestamps"],
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, (existing, now) => ({
    changedFields: ["timestamps"],
    updated: { ...existing, timestamps: updateTimestamps(existing.timestamps, now) },
    target,
  }));
}

export async function mutate(
  hash: string,
  build: (existing: WorkItem.Info, now: number) => WorkItemMutation,
): Promise<WorkItem.Info | undefined> {
  const adapter = Storage.get().workItem;
  if (!adapter) return undefined;

  const existing = adapter.get(hash);
  if (!existing) return undefined;

  const now = Date.now();
  const { updated, changedFields, target, afterPublish } = build(existing, now);
  if (target) assertTransition(existing, target);
  return persistMutation(adapter, existing, updated, now, changedFields, afterPublish);
}

export function persistMutation(
  adapter: WorkItemAdapter,
  existing: WorkItem.Info,
  updated: WorkItem.Info,
  time: number,
  changedFields: string[],
  afterPublish?: (updated: WorkItem.Info) => void,
): WorkItem.Info {
  const versioned: WorkItem.Info = {
    ...updated,
    revision: existing.revision + 1,
  };
  if (!adapter.compareAndSet(updated.hash, existing.revision, versioned)) {
    throw new WorkItemRevisionError(updated.hash);
  }

  const previousStatus = WorkItem.deriveStatus(existing);
  const nextStatus = WorkItem.deriveStatus(versioned);
  if (previousStatus !== nextStatus) {
    Bus.publish(WorkItem.Events.StatusChanged, {
      traceId: crypto.randomUUID(),
      time,
      sessionId: versioned.sessionId,
      payload: { hash: versioned.hash, from: previousStatus, to: nextStatus },
    });
  }
  afterPublish?.(versioned);
  Bus.publish(WorkItem.Events.Updated, {
    traceId: crypto.randomUUID(),
    time,
    sessionId: versioned.sessionId,
    payload: { hash: versioned.hash, fields: changedFields },
  });
  return versioned;
}

function assertTransition(existing: WorkItem.Info, target: WorkItemTransitionTarget): void {
  const status = WorkItem.deriveStatus(existing);
  if (
    target === "started" &&
    (status === "completed" || status === "cancelled" || status === "failed")
  ) {
    throw new Error(`Cannot start a ${status} work item — use retry() for failed items`);
  }
  if (target === "completed" && status === "failed") {
    throw new Error("Cannot complete a failed work item — retry() first");
  }
  if (target === "completed" && status === "cancelled") {
    throw new Error("Cannot complete a cancelled work item");
  }
  if (target === "failed" && status === "completed") {
    throw new Error("Cannot fail a completed work item");
  }
  if (target === "failed" && status === "cancelled") {
    throw new Error("Cannot fail a cancelled work item");
  }
  if (target === "cancelled" && status === "completed") {
    throw new Error("Cannot cancel a completed work item");
  }
}
