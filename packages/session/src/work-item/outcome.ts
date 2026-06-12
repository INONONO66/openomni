import { WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Storage } from "../storage/storage.js";

export async function recordWorkItemOutcome(
  hash: string,
  outcome: WorkItem.Outcome,
): Promise<WorkItem.Info | undefined> {
  const adapter = Storage.get().workItem;
  if (!adapter) return undefined;

  const existing = adapter.get(hash);
  if (!existing) return undefined;

  const status = WorkItem.deriveStatus(existing);
  if (status !== "completed") {
    throw new Error(`Cannot record outcome for a ${status} work item`);
  }

  const now = Date.now();
  const parsedOutcome = WorkItem.Outcome.parse(outcome);
  const updated: WorkItem.Info = {
    ...existing,
    outcome: parsedOutcome,
    timestamps: { ...existing.timestamps, updated: now },
  };
  adapter.set(hash, updated);

  Bus.publish(WorkItem.Events.OutcomeRecorded, {
    traceId: crypto.randomUUID(),
    time: now,
    sessionId: updated.sessionId,
    payload: { hash, outcome: parsedOutcome, sessionId: updated.sessionId },
  });
  Bus.publish(WorkItem.Events.Updated, {
    traceId: crypto.randomUUID(),
    time: now,
    sessionId: updated.sessionId,
    payload: { hash, fields: ["outcome"] },
  });

  return updated;
}
