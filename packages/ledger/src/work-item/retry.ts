import { WorkItem, type Storage as ProtocolStorage } from "@openomni/protocol";
import type { WorkItemFact } from "./facts.js";
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
  fact: WorkItemFact,
  traceId: string,
) => WorkItem.Info;

export function retryWorkItem(
  hash: string,
  adapter: ProtocolStorage.WorkItemSubAdapter | undefined,
  persistMutation: PersistMutation,
  traceId: string,
): WorkItem.Info | undefined {
  if (!adapter) return undefined;

  const existing = adapter.get(hash);
  if (!existing) return undefined;

  if (WorkItem.deriveStatus(existing) !== "failed") {
    throw new Error("retry() can only be called on failed work items");
  }
  if (isRetryExhausted(existing)) {
    recordRetryExhaustion(hash, adapter, existing, persistMutation, traceId);
  }

  const now = Date.now();
  const retryable = retryableItem(existing, now);
  return persistMutation(
    adapter,
    existing,
    retryable,
    now,
    [
      "attempt",
      "timestamps",
      "failureReason",
      "completionContract",
      "executorKind",
      "workerRunId",
      "workSessionId",
      "attemptTerminal",
    ],
    {
      type: "work_item.retried",
      data: { attempt: retryable.attempt, basisRef: retryable.completionContract.basisRef },
    },
    traceId,
  );
}

function recordRetryExhaustion(
  hash: string,
  adapter: ProtocolStorage.WorkItemSubAdapter,
  existing: WorkItem.Info,
  persistMutation: PersistMutation,
  traceId: string,
): never {
  const now = Date.now();
  if (!hasRetryExhaustionBlocker(existing)) {
    const exhausted = exhaustedItem(existing, now);
    const blocker = exhausted.blockers.at(-1);
    persistMutation(
      adapter,
      existing,
      exhausted,
      now,
      ["blockers", "timestamps"],
      {
        type: "work_item.blocker_added",
        data: {
          blockerId: blocker?.id,
          kind: blocker?.kind,
          description: blocker?.description,
        },
      },
      traceId,
    );
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
      basisRef: `${existing.workItemId}:attempt:${nextAttempt}`,
    },
    workerRunId: undefined,
    workSessionId: undefined,
    executorKind: undefined,
    // The retried item starts a fresh execution: the prior attempt's
    // terminal record (#510 D2b) is history on the work stream, not the
    // state of the next attempt.
    attemptTerminal: undefined,
    failureReason: undefined,
    timestamps: {
      ...existing.timestamps,
      failed: undefined,
      started: now,
      updated: now,
    },
  };
}
