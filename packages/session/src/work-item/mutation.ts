import { WorkItem, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Storage } from "../storage/storage.js";
import {
  appendTransitionFact,
  requireWorkItemLedger,
  WorkItemRevisionError,
  type WorkItemFact,
} from "./facts.js";
import type { WorkItemAdapter, WorkItemMutation, WorkItemTransitionTarget } from "./types.js";

export async function mutate(
  hash: string,
  build: (existing: WorkItem.Info, now: number) => WorkItemMutation,
): Promise<WorkItem.Info | undefined> {
  const adapter = Storage.get().workItem;
  if (!adapter) return undefined;

  const existing = adapter.get(hash);
  if (!existing) return undefined;

  const now = Date.now();
  const { updated, changedFields, fact, target, afterPublish } = build(existing, now);
  if (target) assertTransition(existing, target);
  return persistMutation(adapter, existing, updated, now, changedFields, fact, afterPublish);
}

/**
 * Write unit shared with callers that hold their own storage transaction
 * (create's parent link, remove's graph unlinks): appends the decision-class
 * fact, then lands the projection under the revision CAS — no publishes.
 * MUST run inside a storage transaction.
 */
export function commitMutation(
  adapter: WorkItemAdapter,
  ledger: ProtocolStorage.LedgerSubAdapter,
  existing: WorkItem.Info,
  updated: WorkItem.Info,
  fact: WorkItemFact,
): WorkItem.Info {
  const versioned: WorkItem.Info = {
    ...updated,
    revision: existing.revision + 1,
  };
  appendTransitionFact(ledger, existing, fact);
  if (!adapter.compareAndSet(updated.hash, existing.revision, versioned)) {
    // Unreachable while every writer appends first (the append CAS and the
    // projection CAS guard the same head==revision); kept as the explosive
    // backstop — the rollback discards the appended fact.
    throw new WorkItemRevisionError(updated.hash);
  }
  return versioned;
}

export function persistMutation(
  adapter: WorkItemAdapter,
  existing: WorkItem.Info,
  updated: WorkItem.Info,
  time: number,
  changedFields: string[],
  fact: WorkItemFact,
  afterPublish?: (updated: WorkItem.Info) => void,
): WorkItem.Info {
  const storage = Storage.get();
  const ledger = requireWorkItemLedger(storage);
  const versioned = storage.transaction(() =>
    commitMutation(adapter, ledger, existing, updated, fact),
  );

  // Bus stays observe-only for the work-item decision class (#510): these
  // publishes are lossy projections of the appended facts and fire only
  // AFTER the append+projection transaction committed.
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
