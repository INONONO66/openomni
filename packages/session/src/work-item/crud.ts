import { WorkItem, type Storage as ProtocolStorage } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../storage/storage.js";
import { detectCycles } from "./dependency.js";
import { appendTransitionFact, requireWorkItemLedger, runWorkItemTransaction } from "./facts.js";
import { commitMutation, persistMutation } from "./mutation.js";
import type { WorkItemListFilter } from "./types.js";

export function getWorkItem(hash: string): WorkItem.Info | undefined {
  return Storage.get().workItem?.get(hash);
}

export function listWorkItems(filter?: WorkItemListFilter): WorkItem.Info[] {
  return Storage.get().workItem?.list(filter) ?? [];
}

class WorkItemRemoveFailedError extends Error {}

type GraphMutation = Readonly<{
  existing: WorkItem.Info;
  updated: WorkItem.Info;
}>;

type RemovalResult = Readonly<{
  existing: WorkItem.Info;
  mutations: GraphMutation[];
  time: number;
}>;

export function removeWorkItem(hash: string): boolean {
  const adapter = Storage.get();
  const workItem = adapter.workItem;
  if (!workItem) return false;
  const ledger = requireWorkItemLedger(adapter);

  let removal: RemovalResult | undefined;
  try {
    removal = runWorkItemTransaction(adapter, hash, () =>
      removeWorkItemGraph(workItem, ledger, hash),
    );
  } catch (error) {
    if (error instanceof WorkItemRemoveFailedError) return false;
    throw error;
  }
  if (!removal) return false;

  for (const mutation of removal.mutations) {
    Bus.publish(WorkItem.Events.Updated, {
      traceId: crypto.randomUUID(),
      time: removal.time,
      sessionId: mutation.updated.sessionId,
      payload: { hash: mutation.updated.hash, fields: ["relations"] },
    });
  }
  Bus.publish(WorkItem.Events.Removed, {
    traceId: crypto.randomUUID(),
    time: removal.time,
    sessionId: removal.existing.sessionId,
    payload: { hash, sessionId: removal.existing.sessionId },
  });
  return true;
}

function removeWorkItemGraph(
  workItem: NonNullable<Storage.Adapter["workItem"]>,
  ledger: ProtocolStorage.LedgerSubAdapter,
  hash: string,
): RemovalResult | undefined {
  const existing = workItem.get(hash);
  if (!existing) return undefined;
  // Revision 1 is the birth revision (#510 C1) — only items with no
  // transition beyond creation may be removed; the created/adopted fact
  // stays on the owner stream as durable history of the removal.
  if (existing.revision !== 1) {
    throw new Error("Cannot remove WorkItem after durable history exists");
  }

  const time = Date.now();
  const staged = new Map<string, GraphMutation>();
  const stage = (
    item: WorkItem.Info,
    updateRelations: (relations: WorkItem.Info["relations"]) => WorkItem.Info["relations"],
  ) => {
    const current = staged.get(item.hash)?.updated ?? item;
    staged.set(item.hash, {
      existing: staged.get(item.hash)?.existing ?? item,
      updated: {
        ...current,
        relations: updateRelations(current.relations),
        timestamps: { ...current.timestamps, updated: time },
      },
    });
  };

  if (existing.relations.parentHash) {
    const parent = workItem.get(existing.relations.parentHash);
    if (parent?.relations.childHashes.includes(hash)) {
      stage(parent, (relations) => ({
        ...relations,
        childHashes: relations.childHashes.filter((childHash) => childHash !== hash),
      }));
    }
  }

  for (const item of workItem.list()) {
    if (item.relations.dependsOn.includes(hash)) {
      stage(item, (relations) => ({
        ...relations,
        dependsOn: relations.dependsOn.filter((dependencyHash) => dependencyHash !== hash),
      }));
    }
  }

  const mutations = [...staged.values()].map((mutation) => ({
    existing: mutation.existing,
    updated: commitMutation(workItem, ledger, mutation.existing, mutation.updated, {
      type: "work_item.updated",
      data: { fields: ["relations"] },
    }),
  }));
  appendTransitionFact(ledger, existing, {
    type: "work_item.removed",
    data: { removedAt: time },
  });
  if (!workItem.remove(hash)) {
    throw new WorkItemRemoveFailedError(`failed to remove WorkItem: ${hash}`);
  }
  return { existing, mutations, time };
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
    "revision",
    "timestamps",
    "failureReason",
    "attempt",
    "lastAttemptSeq",
    "currentAttemptId",
    "attemptTerminal",
    "maxAttempts",
    "executorKind",
    "workerRunId",
    "workSessionId",
    "blockers",
    "evidence",
    "acceptanceCriteria",
    "completionContract",
    "completionFacts",
    "completionReport",
    "verificationGate",
    "completionTerminalReceipt",
    "outcome",
  ] as const;
  for (const key of managedFields) {
    if (key in fields) {
      throw new Error(`Use lifecycle helpers instead of update() for "${key}"`);
    }
  }
  if (fields.relations) {
    if (fields.relations.parentHash !== undefined) {
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
      updated: now,
    },
    relations: {
      ...existing.relations,
      ...(fields.relations ?? {}),
      parentHash: existing.relations.parentHash,
      childHashes: existing.relations.childHashes,
    },
  };

  return persistMutation(adapter.workItem, existing, updated, now, Object.keys(fields), {
    type: "work_item.updated",
    data: { fields: Object.keys(fields) },
  });
}
