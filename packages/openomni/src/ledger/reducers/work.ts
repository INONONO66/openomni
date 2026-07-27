import type { Ledger } from "@openomni/protocol";

export type WorkStatusV1 = "draft" | "running" | "failed" | "cancelled" | "completed" | "archived";

export interface WorkProjectionV1 {
  readonly workItemId: string;
  readonly status: WorkStatusV1;
  readonly revision: number;
  readonly metadataRef: string | null;
  readonly criteriaRef: string | null;
  readonly dependenciesRef: string | null;
  readonly assignmentRef: string | null;
  readonly deadlineRef: string | null;
  readonly outcomeRef: string | null;
  readonly evidenceRefs: readonly string[];
  readonly readbackRefs: readonly string[];
  readonly activeBlockerRefs: readonly string[];
  readonly resolvedBlockerRefs: readonly string[];
  readonly attemptIds: readonly string[];
  readonly retryExhausted: boolean;
}

const WORK_EVENTS = new Set<Ledger.NativeEventTypeV1>([
  "work.created.v1",
  "work.metadata_revised.v1",
  "work.criteria_revised.v1",
  "work.dependencies_replaced.v1",
  "work.started.v1",
  "work.evidence_recorded.v1",
  "work.readback_evidence_recorded.v1",
  "work.blocker_added.v1",
  "work.blocker_resolved.v1",
  "work.failed.v1",
  "work.cancelled.v1",
  "work.retry_exhausted.v1",
  "work.outcome_recorded.v1",
  "work.archived.v1",
  "work.assignment_changed.v1",
  "work.deadline_changed.v1",
  "work.completed.v1",
]);

function ref(envelope: Ledger.EnvelopeV1): string {
  const snapshot = envelope.event.payload.workSnapshotRef;
  if (snapshot === undefined) throw new Error("work event missing projection snapshot ref");
  return snapshot.digest;
}

function appendUnique(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values : Object.freeze([...values, value]);
}

/** Rebuilds the complete work projection from committed facts only. */
export function reduceWorkProjection(
  workItemId: string,
  events: readonly Ledger.EnvelopeV1[],
): WorkProjectionV1 | null {
  let state: WorkProjectionV1 | null = null;
  for (const envelope of [...events].sort((a, b) => a.ownerSeq - b.ownerSeq)) {
    const { event } = envelope;
    if (event.payload.subjectId !== workItemId || !WORK_EVENTS.has(event.eventType)) continue;
    const dataRef = ref(envelope);
    if (event.eventType === "work.created.v1") {
      if (state !== null) throw new Error("invalid work history: duplicate creation");
      state = Object.freeze({
        workItemId,
        status: "draft",
        revision: 1,
        metadataRef: dataRef,
        criteriaRef: dataRef,
        dependenciesRef: dataRef,
        assignmentRef: null,
        deadlineRef: null,
        outcomeRef: null,
        evidenceRefs: Object.freeze([]),
        readbackRefs: Object.freeze([]),
        activeBlockerRefs: Object.freeze([]),
        resolvedBlockerRefs: Object.freeze([]),
        attemptIds: Object.freeze([]),
        retryExhausted: false,
      });
      continue;
    }
    if (state === null) throw new Error("invalid work history: event before creation");
    let next: WorkProjectionV1 = { ...state, revision: state.revision + 1 };
    switch (event.eventType) {
      case "work.metadata_revised.v1":
        next = { ...next, metadataRef: dataRef };
        break;
      case "work.criteria_revised.v1":
        next = { ...next, criteriaRef: dataRef };
        break;
      case "work.dependencies_replaced.v1":
        next = { ...next, dependenciesRef: dataRef };
        break;
      case "work.started.v1":
        next = { ...next, status: "running" };
        break;
      case "work.evidence_recorded.v1":
        next = { ...next, evidenceRefs: appendUnique(state.evidenceRefs, dataRef) };
        break;
      case "work.readback_evidence_recorded.v1":
        next = { ...next, readbackRefs: appendUnique(state.readbackRefs, dataRef) };
        break;
      case "work.blocker_added.v1":
        next = { ...next, activeBlockerRefs: appendUnique(state.activeBlockerRefs, dataRef) };
        break;
      case "work.blocker_resolved.v1":
        next = {
          ...next,
          activeBlockerRefs: Object.freeze(
            state.activeBlockerRefs.filter((item) => item !== dataRef),
          ),
          resolvedBlockerRefs: appendUnique(state.resolvedBlockerRefs, dataRef),
        };
        break;
      case "work.failed.v1":
        next = { ...next, status: "failed" };
        break;
      case "work.cancelled.v1":
        next = { ...next, status: "cancelled" };
        break;
      case "work.retry_exhausted.v1":
        next = { ...next, retryExhausted: true };
        break;
      case "work.outcome_recorded.v1":
        next = { ...next, outcomeRef: dataRef };
        break;
      case "work.archived.v1":
        next = { ...next, status: "archived" };
        break;
      case "work.assignment_changed.v1":
        next = { ...next, assignmentRef: dataRef };
        break;
      case "work.deadline_changed.v1":
        next = { ...next, deadlineRef: dataRef };
        break;
      case "work.completed.v1":
        next = { ...next, status: "completed" };
        break;
    }
    state = Object.freeze(next);
  }
  if (state === null) return null;
  const attemptIds = [...events]
    .sort((a, b) => a.ownerSeq - b.ownerSeq)
    .filter(({ event }) => event.eventType === "attempt.allocated.v1")
    .map(({ event }) => event.payload.attemptId)
    .filter((attemptId): attemptId is string => attemptId !== undefined);
  return Object.freeze({ ...state, attemptIds: Object.freeze([...new Set(attemptIds)]) });
}
