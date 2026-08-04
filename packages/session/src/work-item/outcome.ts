import { WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { mutate } from "./mutation.js";

export async function recordWorkItemOutcome(
  hash: string,
  outcome: WorkItem.Outcome,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, (existing, now) => {
    const status = WorkItem.deriveStatus(existing);
    if (status !== "completed") {
      throw new Error(`Cannot record outcome for a ${status} work item`);
    }

    const parsedOutcome = WorkItem.Outcome.parse(outcome);
    return {
      changedFields: ["outcome"],
      updated: {
        ...existing,
        outcome: parsedOutcome,
        timestamps: { ...existing.timestamps, updated: now },
      },
      afterPublish: (updated) => {
        Bus.publish(WorkItem.Events.OutcomeRecorded, {
          traceId: crypto.randomUUID(),
          time: now,
          sessionId: updated.sessionId,
          payload: { hash, outcome: parsedOutcome, sessionId: updated.sessionId },
        });
      },
    };
  });
}
