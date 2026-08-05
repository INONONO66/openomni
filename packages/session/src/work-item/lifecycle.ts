import { WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { Storage } from "../storage/storage.js";
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

class CompletionAdmissionRequiredError extends Error {
  readonly name = "CompletionAdmissionRequiredError";
  readonly code = "admission_required";

  constructor() {
    super("completion admission is required before closing a WorkItem");
  }
}

export async function completeWorkItem(
  _hash: string,
  _completionReport: WorkItem.CompletionReport,
): Promise<WorkItem.Info | undefined> {
  throw new CompletionAdmissionRequiredError();
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
  evidence: Omit<WorkItem.Evidence, "id" | "createdAt" | "attempt" | "basisRef"> &
    Readonly<{ id?: string }>,
): Promise<WorkItem.Info | undefined> {
  const explicitId = evidence.id;
  if (explicitId !== undefined) {
    const existing = Storage.get().workItem?.get(hash);
    const recorded = existing?.evidence.find(({ id }) => id === explicitId);
    if (existing && recorded) {
      const candidate = WorkItem.Evidence.parse({
        ...evidence,
        id: explicitId,
        attempt: recorded.attempt,
        basisRef: recorded.basisRef,
        createdAt: recorded.createdAt,
      });
      if (JSON.stringify(recorded) !== JSON.stringify(candidate)) {
        throw new Error(`WorkItem evidence identity conflict: ${explicitId}`);
      }
      return existing;
    }
  }
  return mutate(hash, (existing, now) => ({
    changedFields: ["evidence"],
    updated: {
      ...existing,
      evidence: [
        ...existing.evidence,
        WorkItem.Evidence.parse({
          ...evidence,
          id: explicitId ?? crypto.randomUUID(),
          attempt: existing.attempt,
          basisRef: existing.completionContract.basisRef,
          createdAt: now,
        }),
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
