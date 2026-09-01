import { WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../storage/storage.js";
import { buildWorkItem } from "./builder.js";
import { detectCycles } from "./dependency.js";
import {
  appendCreatedFact,
  requireWorkItemLedger,
  runWorkItemTransaction,
} from "./facts.js";
import { commitMutation } from "./mutation.js";
import type { CreateWorkItemInput } from "./types.js";

export async function createWorkItem(
  input: CreateWorkItemInput,
  traceId: string,
): Promise<WorkItem.Info> {
  const storage = Storage.get();
  const workItem = storage.workItem;
  if (!workItem) {
    // Fail closed like every other WorkItem write (facts.ts): the old warn-
    // and-fabricate path returned a phantom Info that was never persisted —
    // a hash indistinguishable from a real create.
    throw new Error("WorkItem storage not configured — refusing to fabricate a work item");
  }
  const ledger = requireWorkItemLedger(storage);

  if (input.dependsOn && input.dependsOn.length > 0) {
    detectCycles(workItem, input.dependsOn, new Set());
  }

  const now = Date.now();
  const parent = input.parentId ? workItem.get(input.parentId) : undefined;
  if (input.parentId && !parent) {
    throw new Error(`Parent work item not found: ${input.parentId}`);
  }

  const item = buildWorkItem(input, now);
  // work_item.created is the birth fact (seq 1 == revision 1); the parent
  // child-link rides the SAME transaction, so a stale parent head rolls the
  // whole create back — no compensating remove.
  let linkedParent: WorkItem.Info | undefined;
  runWorkItemTransaction(storage, item.workItemId, () => {
    // The birth fact and the projection INSERT commit together: a duplicate
    // detected by EITHER the append CAS or the INSERT raises the same typed
    // duplicate error, and a refused INSERT leaves no orphan birth fact.
    appendCreatedFact(
      ledger,
      item,
      {
        name: item.name,
        sourceMessageId: item.sourceMessageId,
        sourceChannel: item.sourceChannel,
        dependsOn: item.relations.dependsOn,
        maxAttempts: item.maxAttempts,
        ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
        ...(item.assigneeId === undefined ? {} : { assigneeId: item.assigneeId }),
        ...(item.relations.parentId === undefined ? {} : { parentId: item.relations.parentId }),
        ...(item.executorKind === undefined ? {} : { executorKind: item.executorKind }),
      },
      () => workItem.create(item.workItemId, item),
    );
    if (parent && !parent.relations.childIds.includes(item.workItemId)) {
      linkedParent = commitMutation(
        workItem,
        ledger,
        parent,
        {
          ...parent,
          relations: {
            ...parent.relations,
            childIds: [...parent.relations.childIds, item.workItemId],
          },
          timestamps: { ...parent.timestamps, updated: now },
        },
        { type: "work_item.updated", data: { fields: ["relations"] } },
      );
    }
  });

  // ONE create = ONE trace (D11): the parent-link Updated and the Created
  // projection describe the same transaction, so they share the caller's id.
  if (linkedParent) {
    Bus.publish(WorkItem.Events.Updated, {
      traceId,
      time: now,
      sessionId: linkedParent.sessionId,
      payload: { workItemId: linkedParent.workItemId, fields: ["relations"] },
    });
  }
  Bus.publish(WorkItem.Events.Created, {
    traceId,
    time: now,
    sessionId: item.sessionId,
    payload: {
      workItemId: item.workItemId,
      name: item.name,
      sessionId: item.sessionId,
      assigneeId: item.assigneeId,
    },
  });

  return item;
}
