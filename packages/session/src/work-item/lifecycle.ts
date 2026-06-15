import { WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Storage } from "../storage/storage.js";
import { verifyCompletionReport } from "./completion-report.js";
import { areWorkItemDependenciesMet } from "./dependency.js";
import { mutate, mutateTimestamps, persistMutation } from "./mutation.js";
import { recordWorkItemOutcome } from "./outcome.js";
import { retryWorkItem } from "./retry.js";

export async function startWorkItem(hash: string): Promise<WorkItem.Info | undefined> {
  return mutateTimestamps(hash, "started", (timestamps, now) => ({
    ...timestamps,
    started: now,
    updated: now,
  }));
}

export async function completeWorkItem(
  hash: string,
  completionReport: WorkItem.CompletionReport,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, (existing, now) => ({
    changedFields: ["timestamps", "completionReport"],
    target: "completed",
    updated: {
      ...existing,
      completionReport: verifyCompletionReport(existing, completionReport),
      timestamps: { ...existing.timestamps, completed: now, updated: now },
    },
    afterPublish: (updated) => {
      Bus.publish(WorkItem.Events.Completed, {
        traceId: crypto.randomUUID(),
        time: now,
        sessionId: updated.sessionId,
        payload: { hash, sessionId: updated.sessionId },
      });
    },
  }));
}

export async function failWorkItem(
  hash: string,
  reason?: string,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, (existing, now) => ({
    changedFields: ["timestamps", "failureReason"],
    target: "failed",
    updated: {
      ...existing,
      timestamps: { ...existing.timestamps, failed: now, updated: now },
      failureReason: reason,
    },
    afterPublish: (updated) => {
      Bus.publish(WorkItem.Events.Failed, {
        traceId: crypto.randomUUID(),
        time: now,
        sessionId: updated.sessionId,
        payload: { hash, reason, sessionId: updated.sessionId },
      });
    },
  }));
}

export async function cancelWorkItem(hash: string): Promise<WorkItem.Info | undefined> {
  return mutateTimestamps(hash, "cancelled", (timestamps, now) => ({
    ...timestamps,
    cancelled: now,
    updated: now,
  }));
}

export async function addWorkItemBlocker(
  hash: string,
  blocker: Omit<WorkItem.Blocker, "id" | "createdAt">,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, (existing, now) => ({
    changedFields: ["blockers"],
    updated: {
      ...existing,
      blockers: [...existing.blockers, { id: crypto.randomUUID(), ...blocker, createdAt: now }],
      timestamps: { ...existing.timestamps, updated: now },
    },
  }));
}

export async function resolveWorkItemBlocker(
  hash: string,
  blockerId: string,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, (existing, now) => ({
    changedFields: ["blockers"],
    updated: {
      ...existing,
      blockers: existing.blockers.map((blocker) =>
        blocker.id === blockerId ? { ...blocker, resolvedAt: now } : blocker,
      ),
      timestamps: { ...existing.timestamps, updated: now },
    },
  }));
}

export async function addWorkItemEvidence(
  hash: string,
  evidence: Omit<WorkItem.Evidence, "id" | "createdAt">,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, (existing, now) => ({
    changedFields: ["evidence"],
    updated: {
      ...existing,
      evidence: [
        ...existing.evidence,
        WorkItem.Evidence.parse({ id: crypto.randomUUID(), ...evidence, createdAt: now }),
      ],
      timestamps: { ...existing.timestamps, updated: now },
    },
  }));
}

export async function addWorkItemReadBackEvidence(
  hash: string,
  check: WorkItem.ReadBackCheck,
): Promise<WorkItem.Info | undefined> {
  const readBack = WorkItem.ReadBackCheck.parse(check);
  return addWorkItemEvidence(hash, {
    kind: "verification",
    description: `${readBack.kind} read-back ${readBack.passed ? "passed" : "failed"} for ${readBack.target}`,
    passed: readBack.passed,
    detail: JSON.stringify(readBack),
    readBack,
  });
}

export const recordOutcome = recordWorkItemOutcome;
export const areDependenciesMet = areWorkItemDependenciesMet;

export async function retryStoredWorkItem(hash: string): Promise<WorkItem.Info | undefined> {
  return retryWorkItem(hash, Storage.get().workItem, persistMutation);
}
