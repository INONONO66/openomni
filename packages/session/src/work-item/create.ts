import { Operational, WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../storage/storage.js";
import { buildWorkItem } from "./builder.js";
import { detectCycles } from "./dependency.js";
import {
  appendCreatedFact,
  requireWorkItemLedger,
  runWorkItemTransaction,
  WorkItemDuplicateError,
} from "./facts.js";
import { commitMutation } from "./mutation.js";
import type { CreateWorkItemInput } from "./types.js";

export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItem.Info> {
  const storage = Storage.get();
  const workItem = storage.workItem;
  if (!workItem) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      sessionId: input.sessionId,
      component: "work-item",
      msg: "WorkItem storage not configured, skipping create",
    });
    return buildWorkItem(input, Date.now());
  }
  const ledger = requireWorkItemLedger(storage);

  if (input.dependsOn && input.dependsOn.length > 0) {
    detectCycles(workItem, input.dependsOn, new Set());
  }

  const now = Date.now();
  const parent = input.parentHash ? workItem.get(input.parentHash) : undefined;
  if (input.parentHash && !parent) {
    throw new Error(`Parent work item not found: ${input.parentHash}`);
  }

  const item = buildWorkItem(input, now);
  // work_item.created is the birth fact (seq 1 == revision 1); the parent
  // child-link rides the SAME transaction, so a stale parent head rolls the
  // whole create back — no compensating remove.
  let linkedParent: WorkItem.Info | undefined;
  runWorkItemTransaction(storage, item.hash, () => {
    appendCreatedFact(ledger, item, {
      name: item.name,
      sourceMessageId: item.sourceMessageId,
      sourceChannel: item.sourceChannel,
      dependsOn: item.relations.dependsOn,
      maxAttempts: item.maxAttempts,
      ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
      ...(item.assigneeId === undefined ? {} : { assigneeId: item.assigneeId }),
      ...(item.relations.parentHash === undefined ? {} : { parentHash: item.relations.parentHash }),
      ...(item.executorKind === undefined ? {} : { executorKind: item.executorKind }),
    });
    if (!workItem.create(item.hash, item)) throw new WorkItemDuplicateError(item.hash);
    if (parent && !parent.relations.childHashes.includes(item.hash)) {
      linkedParent = commitMutation(
        workItem,
        ledger,
        parent,
        {
          ...parent,
          relations: {
            ...parent.relations,
            childHashes: [...parent.relations.childHashes, item.hash],
          },
          timestamps: { ...parent.timestamps, updated: now },
        },
        { type: "work_item.updated", data: { fields: ["relations"] } },
      );
    }
  });

  if (linkedParent) {
    Bus.publish(WorkItem.Events.Updated, {
      traceId: crypto.randomUUID(),
      time: now,
      sessionId: linkedParent.sessionId,
      payload: { hash: linkedParent.hash, fields: ["relations"] },
    });
  }
  Bus.publish(WorkItem.Events.Created, {
    traceId: crypto.randomUUID(),
    time: now,
    sessionId: item.sessionId,
    payload: {
      hash: item.hash,
      name: item.name,
      sessionId: item.sessionId,
      assigneeId: item.assigneeId,
    },
  });

  return item;
}
