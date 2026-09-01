import { WorkItem, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../storage/storage.js";
import {
  appendTransitionFact,
  requireWorkItemLedger,
  runWorkItemTransaction,
  type WorkItemFact,
} from "./facts.js";
import type { WorkItemAdapter, WorkItemMutation, WorkItemTransitionTarget } from "./types.js";

export async function mutate(
  hash: string,
  traceId: string,
  build: (existing: WorkItem.Info, now: number) => WorkItemMutation,
): Promise<WorkItem.Info | undefined> {
  const adapter = Storage.get().workItem;
  if (!adapter) {
    // Fail closed like create.ts: returning undefined here was
    // indistinguishable from "work item not found".
    throw new Error("WorkItem storage not configured — refusing to skip a work-item mutation");
  }

  const existing = adapter.get(hash);
  if (!existing) return undefined;

  const now = Date.now();
  const { updated, changedFields, fact, target, afterPublish } = build(existing, now);
  if (target) assertTransition(existing, target);
  return persistMutation(
    adapter,
    existing,
    updated,
    now,
    changedFields,
    fact,
    traceId,
    afterPublish,
  );
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
  // One commit: the fact appends at `existing.revision`, then the projection
  // CAS lands against the same head. Either refusal raises the SAME typed
  // revision error the two-step spelling raised, and the coordinator discards
  // the fact when the CAS loses, so head never outruns revision.
  appendTransitionFact(ledger, existing, fact, () =>
    adapter.compareAndSet(updated.workItemId, existing.revision, versioned),
  );
  return versioned;
}

export function persistMutation(
  adapter: WorkItemAdapter,
  existing: WorkItem.Info,
  updated: WorkItem.Info,
  time: number,
  changedFields: string[],
  fact: WorkItemFact,
  traceId: string,
  afterPublish?: (updated: WorkItem.Info, traceId: string) => void,
): WorkItem.Info {
  const storage = Storage.get();
  const ledger = requireWorkItemLedger(storage);
  const versioned = runWorkItemTransaction(storage, existing.workItemId, () =>
    commitMutation(adapter, ledger, existing, updated, fact),
  );

  // Bus stays observe-only for the work-item decision class (#510): these
  // publishes are lossy projections of the appended facts and fire only
  // AFTER the append+projection transaction committed. They are ONE state
  // transition, so they share the caller's ONE traceId (D11) — previously
  // each publish minted its own, splitting one transition across 2-3 traces.
  const previousStatus = WorkItem.deriveStatus(existing);
  const nextStatus = WorkItem.deriveStatus(versioned);
  if (previousStatus !== nextStatus) {
    Bus.publish(WorkItem.Events.StatusChanged, {
      traceId,
      time,
      sessionId: versioned.sessionId,
      payload: { workItemId: versioned.workItemId, from: previousStatus, to: nextStatus },
    });
  }
  afterPublish?.(versioned, traceId);
  Bus.publish(WorkItem.Events.Updated, {
    traceId,
    time,
    sessionId: versioned.sessionId,
    payload: { workItemId: versioned.workItemId, fields: changedFields },
  });
  return versioned;
}

function assertTransition(existing: WorkItem.Info, target: WorkItemTransitionTarget): void {
  const status = WorkItem.deriveStatus(existing);
  if (
    target === "started" &&
    (status === "completed" || status === "cancelled" || status === "failed")
  ) {
    throw new Error(`Cannot start a ${status} work item`);
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
