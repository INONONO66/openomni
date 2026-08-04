import { WorkItem, type Storage as ProtocolStorage } from "@openomni/protocol";
import {
  hasRetryExhaustionBlocker,
  isRetryExhausted,
  retryExhaustionDescription,
} from "./retry-policy.js";

type PersistMutation = (
  adapter: ProtocolStorage.WorkItemSubAdapter,
  existing: WorkItem.Info,
  updated: WorkItem.Info,
  time: number,
  changedFields: string[],
) => WorkItem.Info;

export function retryWorkItem(
  hash: string,
  adapter: ProtocolStorage.WorkItemSubAdapter | undefined,
  persistMutation: PersistMutation,
): WorkItem.Info | undefined {
  if (!adapter) return undefined;

  const existing = adapter.get(hash);
  if (!existing) return undefined;

  if (WorkItem.deriveStatus(existing) !== "failed") {
    throw new Error("retry() can only be called on failed work items");
  }
  if (isRetryExhausted(existing)) {
    recordRetryExhaustion(hash, adapter, existing, persistMutation);
  }

  const now = Date.now();
  return persistMutation(adapter, existing, retryableItem(existing, now), now, [
    "attempt",
    "timestamps",
    "failureReason",
    "completionContract",
  ]);
}

function recordRetryExhaustion(
  hash: string,
  adapter: ProtocolStorage.WorkItemSubAdapter,
  existing: WorkItem.Info,
  persistMutation: PersistMutation,
): never {
  const now = Date.now();
  if (!hasRetryExhaustionBlocker(existing)) {
    persistMutation(adapter, existing, exhaustedItem(existing, now), now, [
      "blockers",
      "timestamps",
    ]);
  }
  throw new Error(
    `retry attempts exhausted for work item ${hash}: attempt ${existing.attempt} of ${existing.maxAttempts}`,
  );
}

function exhaustedItem(existing: WorkItem.Info, now: number): WorkItem.Info {
  return {
    ...existing,
    blockers: [
      ...existing.blockers,
      {
        id: crypto.randomUUID(),
        kind: "waiting_input",
        description: retryExhaustionDescription(existing),
        createdAt: now,
      },
    ],
    timestamps: { ...existing.timestamps, updated: now },
  };
}

function retryableItem(existing: WorkItem.Info, now: number): WorkItem.Info {
  const nextAttempt = existing.attempt + 1;
  return {
    ...existing,
    attempt: nextAttempt,
    completionContract: {
      ...existing.completionContract,
      basisRef: `${existing.hash}:attempt:${nextAttempt}`,
    },
    failureReason: undefined,
    timestamps: {
      ...existing.timestamps,
      failed: undefined,
      started: now,
      updated: now,
    },
  };
}
