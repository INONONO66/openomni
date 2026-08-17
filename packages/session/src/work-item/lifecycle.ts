import { WorkItem } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../storage/storage.js";
import { attemptAllocatedFact } from "./facts.js";
import { mutate, persistMutation } from "./mutation.js";
import { retryWorkItem } from "./retry.js";

export async function startWorkItem(
  hash: string,
  traceId: string,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, traceId, (existing, now) => ({
    changedFields: ["timestamps"],
    target: "started",
    fact: { type: "work_item.started", data: { startedAt: now } },
    updated: {
      ...existing,
      timestamps: { ...existing.timestamps, started: now, updated: now },
    },
  }));
}

export async function failWorkItem(
  hash: string,
  traceId: string,
  reason?: string,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, traceId, (existing, now) => ({
    changedFields: ["timestamps", "failureReason"],
    target: "failed",
    fact: {
      type: "work_item.failed",
      data: { failedAt: now, ...(reason === undefined ? {} : { reason }) },
    },
    updated: {
      ...existing,
      timestamps: { ...existing.timestamps, failed: now, updated: now },
      failureReason: reason,
    },
    afterPublish: (updated, publishTraceId) => {
      Bus.publish(WorkItem.Events.Failed, {
        traceId: publishTraceId,
        time: now,
        sessionId: updated.sessionId,
        payload: { hash, reason, sessionId: updated.sessionId },
      });
    },
  }));
}

export async function cancelWorkItem(
  hash: string,
  traceId: string,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, traceId, (existing, now) => ({
    changedFields: ["timestamps"],
    target: "cancelled",
    fact: { type: "work_item.cancelled", data: { cancelledAt: now } },
    updated: {
      ...existing,
      timestamps: { ...existing.timestamps, cancelled: now, updated: now },
    },
  }));
}

export async function assignWorkItemExecution(
  hash: string,
  assignment: Readonly<{
    executorKind: WorkItem.ExecutorKind;
    workerRunId: string;
    workSessionId: string;
  }>,
  traceId: string,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, traceId, (existing, now) => {
    const status = WorkItem.deriveStatus(existing);
    if (status === "completed" || status === "failed" || status === "cancelled") {
      throw new Error(`Cannot assign execution to a ${status} work item`);
    }
    if (existing.workerRunId || existing.workSessionId || existing.executorKind) {
      throw new Error(`WorkItem already has an execution assignment: ${hash}`);
    }
    return {
      changedFields: ["executorKind", "workerRunId", "workSessionId"],
      fact: { type: "work_item.execution_assigned", data: { ...assignment } },
      updated: {
        ...existing,
        ...assignment,
        timestamps: { ...existing.timestamps, updated: now },
      },
    };
  });
}

export type AttemptAllocationInput = Readonly<{
  contentFingerprint: WorkItem.ContentFingerprint;
  environmentFingerprint: WorkItem.EnvironmentFingerprint;
  /** Cache-hit reuse lineage — dormant in C2 (no lookup exists yet). */
  reusedFromAttemptId?: string;
}>;

/**
 * #510 C2 — allocates the next Attempt identity for a WorkItem. Fingerprint
 * materials are supplied BY THE CALLER (the kernel spawn site owns model +
 * environment); this store stays dumb and records what it is given. The
 * store owns identity allocation: attemptId is minted here, attemptSeq is
 * `lastAttemptSeq + 1` under the stream's serialized append, and retryOf is
 * the recorded prior attemptId on this WorkItem (lineage, never
 * equivalence) — pre-C2 retries recorded no attemptId, so their lineage
 * surfaces as null (phase D closes that gap).
 */
export async function allocateWorkItemAttempt(
  hash: string,
  identity: AttemptAllocationInput,
  traceId: string,
): Promise<Readonly<{ item: WorkItem.Info; attempt: WorkItem.Attempt }> | undefined> {
  let allocated: WorkItem.Attempt | undefined;
  const item = await mutate(hash, traceId, (existing, now) => {
    const status = WorkItem.deriveStatus(existing);
    if (status === "completed" || status === "cancelled" || status === "failed") {
      throw new Error(`Cannot allocate an attempt on a ${status} work item`);
    }
    const attempt = WorkItem.Attempt.parse({
      attemptId: WorkItem.generateAttemptId(),
      attemptSeq: existing.lastAttemptSeq + 1,
      retryOf: existing.currentAttemptId ?? null,
      contentFingerprint: identity.contentFingerprint,
      environmentFingerprint: identity.environmentFingerprint,
      reusedFromAttemptId: identity.reusedFromAttemptId ?? null,
    });
    allocated = attempt;
    return {
      changedFields: ["lastAttemptSeq", "currentAttemptId", "attemptTerminal", "timestamps"],
      fact: attemptAllocatedFact(existing, attempt),
      updated: {
        ...existing,
        lastAttemptSeq: attempt.attemptSeq,
        currentAttemptId: attempt.attemptId,
        // A new execution instance begins: the previous attempt's terminal
        // record (#510 D2b) no longer describes the current attempt.
        attemptTerminal: undefined,
        timestamps: { ...existing.timestamps, updated: now },
      },
    };
  });
  if (!item || !allocated) return undefined;
  return { item, attempt: allocated };
}

export async function addWorkItemBlocker(
  hash: string,
  blocker: Omit<WorkItem.Blocker, "id" | "createdAt"> & Readonly<{ id?: string }>,
  traceId: string,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, traceId, (existing, now) => {
    const added = { ...blocker, id: blocker.id ?? crypto.randomUUID(), createdAt: now };
    return {
      changedFields: ["blockers"],
      fact: {
        type: "work_item.blocker_added",
        data: { blockerId: added.id, kind: added.kind, description: added.description },
      },
      updated: {
        ...existing,
        blockers: [...existing.blockers, added],
        timestamps: { ...existing.timestamps, updated: now },
      },
    };
  });
}

export async function resolveWorkItemBlocker(
  hash: string,
  blockerId: string,
  traceId: string,
): Promise<WorkItem.Info | undefined> {
  return mutate(hash, traceId, (existing, now) => ({
    changedFields: ["blockers"],
    fact: { type: "work_item.blocker_resolved", data: { blockerId, resolvedAt: now } },
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
  traceId: string,
  expectedScope?: Readonly<{ expectedAttempt: number; expectedBasisRef: string }>,
): Promise<WorkItem.Info | undefined> {
  const explicitId = evidence.id;
  if (explicitId !== undefined) {
    const existing = Storage.get().workItem?.get(hash);
    assertEvidenceScope(existing, expectedScope);
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
  return mutate(hash, traceId, (existing, now) => {
    assertEvidenceScope(existing, expectedScope);
    const appended = WorkItem.Evidence.parse({
      ...evidence,
      id: explicitId ?? crypto.randomUUID(),
      attempt: existing.attempt,
      basisRef: existing.completionContract.basisRef,
      createdAt: now,
    });
    return {
      changedFields: ["evidence"],
      fact: {
        type: "work_item.evidence_appended",
        data: {
          evidenceId: appended.id,
          kind: appended.kind,
          passed: appended.passed,
          attempt: appended.attempt,
          basisRef: appended.basisRef,
          ...(appended.criterionId === undefined ? {} : { criterionId: appended.criterionId }),
        },
      },
      updated: {
        ...existing,
        evidence: [...existing.evidence, appended],
        timestamps: { ...existing.timestamps, updated: now },
      },
    };
  });
}

export async function retryStoredWorkItem(
  hash: string,
  traceId: string,
): Promise<WorkItem.Info | undefined> {
  return retryWorkItem(hash, Storage.get().workItem, persistMutation, traceId);
}

function assertEvidenceScope(
  existing: WorkItem.Info | undefined,
  expectedScope: Readonly<{ expectedAttempt: number; expectedBasisRef: string }> | undefined,
): void {
  if (
    existing &&
    expectedScope &&
    (existing.attempt !== expectedScope.expectedAttempt ||
      existing.completionContract.basisRef !== expectedScope.expectedBasisRef)
  ) {
    throw new Error("WorkItem attempt changed before evidence recording");
  }
}

export async function addWorkItemReadBackEvidence(
  hash: string,
  check: WorkItem.ReadBackCheck,
  traceId: string,
  expectedScope?: Readonly<{
    expectedAttempt: number;
    expectedBasisRef: string;
    criterionId: string;
    evidenceId?: string;
  }>,
): Promise<WorkItem.Info | undefined> {
  const readBack = WorkItem.ReadBackCheck.parse(check);
  return addWorkItemEvidence(
    hash,
    {
      kind: "verification",
      description: `${readBack.kind} read-back ${readBack.passed ? "passed" : "failed"} for ${readBack.target}`,
      passed: readBack.passed,
      detail: JSON.stringify(readBack),
      readBack,
      criterionId: expectedScope?.criterionId,
      id: expectedScope?.evidenceId,
    },
    traceId,
    expectedScope,
  );
}
