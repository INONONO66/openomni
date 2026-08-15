import { WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { mutate } from "./mutation.js";

export async function recordWorkItemOutcome(
  hash: string,
  outcome: WorkItem.Outcome,
  traceId: string,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, traceId, (existing, now) => {
    const status = WorkItem.deriveStatus(existing);
    if (status !== "completed") {
      throw new Error(`Cannot record outcome for a ${status} work item`);
    }

    const parsedOutcome = WorkItem.Outcome.parse(outcome);
    return {
      changedFields: ["outcome"],
      fact: { type: "work_item.outcome_recorded", data: { outcome: parsedOutcome } },
      updated: {
        ...existing,
        outcome: parsedOutcome,
        timestamps: { ...existing.timestamps, updated: now },
      },
      afterPublish: (updated, publishTraceId) => {
        Bus.publish(WorkItem.Events.OutcomeRecorded, {
          traceId: publishTraceId,
          time: now,
          sessionId: updated.sessionId,
          payload: { hash, outcome: parsedOutcome, sessionId: updated.sessionId },
        });
      },
    };
  });
}
