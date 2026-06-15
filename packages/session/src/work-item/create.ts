import { Operational, WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Storage } from "../storage/storage.js";
import { buildWorkItem } from "./builder.js";
import { detectCycles } from "./dependency.js";
import type { CreateWorkItemInput } from "./types.js";

export async function createWorkItem(input: CreateWorkItemInput): Promise<WorkItem.Info> {
  const adapter = Storage.get();
  if (!adapter.workItem) {
    Bus.publish(Operational.Warn, {
      traceId: crypto.randomUUID(),
      time: Date.now(),
      sessionId: input.sessionId,
      component: "work-item",
      msg: "WorkItem storage not configured, skipping create",
    });
    return buildWorkItem(input, Date.now());
  }

  if (input.dependsOn && input.dependsOn.length > 0) {
    detectCycles(adapter.workItem, input.dependsOn, new Set());
  }

  const now = Date.now();
  const parent = input.parentHash ? adapter.workItem.get(input.parentHash) : undefined;
  if (input.parentHash && !parent) {
    throw new Error(`Parent work item not found: ${input.parentHash}`);
  }

  const item = buildWorkItem(input, now);
  adapter.workItem.set(item.hash, item);

  if (parent && !parent.relations.childHashes.includes(item.hash)) {
    adapter.workItem.set(parent.hash, {
      ...parent,
      relations: {
        ...parent.relations,
        childHashes: [...parent.relations.childHashes, item.hash],
      },
      timestamps: { ...parent.timestamps, updated: now },
    });
    Bus.publish(WorkItem.Events.Updated, {
      traceId: crypto.randomUUID(),
      time: now,
      sessionId: parent.sessionId,
      payload: { hash: parent.hash, fields: ["relations"] },
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
