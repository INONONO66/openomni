import type { Ledger } from "@openomni/protocol";

export type CompletionStatusV1 = "candidate" | "rejected" | "admitted";

export interface CompletionProjectionV1 {
  readonly workItemId: string;
  readonly candidateRef: string;
  readonly status: CompletionStatusV1;
  readonly verdictRefs: readonly string[];
  readonly decisionRef: string | null;
  readonly revision: number;
  readonly stakesAsOfLedgerSeq: number;
  readonly stakesAsOfDbMs: number;
}

const COMPLETION_EVENTS = new Set<Ledger.NativeEventTypeV1>([
  "completion.candidate.submitted.v1",
  "completion.claim_verdict_recorded.v1",
  "completion.candidate_rejected.v1",
  "completion.decision_recorded.v1",
]);

function digest(ref: { readonly digest: string } | null | undefined, name: string): string {
  if (ref === null || ref === undefined || ref.digest.length === 0) {
    throw new Error(`invalid completion history: ${name} is missing`);
  }
  return ref.digest;
}

function exactVerdictDigests(envelope: Ledger.EnvelopeV1): readonly string[] {
  const refs = envelope.event.payload.verdictArtifactRefs;
  if (refs === undefined)
    throw new Error("invalid completion history: verdict coverage is missing");
  const digests = refs.map((artifactRef) => digest(artifactRef, "verdict artifact ref"));
  if (new Set(digests).size !== digests.length) {
    throw new Error("invalid completion history: duplicate terminal claim verdict");
  }
  return Object.freeze(digests);
}

function sameOrderedRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Rebuilds completion truth, freezing the candidate's ledger/DB-time stakes boundary. */
export function reduceCompletionProjection(
  workItemId: string,
  events: readonly Ledger.EnvelopeV1[],
): CompletionProjectionV1 | null {
  let state: CompletionProjectionV1 | null = null;
  for (const envelope of [...events].sort((a, b) => a.ownerSeq - b.ownerSeq)) {
    const { event } = envelope;
    if (event.payload.subjectId !== workItemId || !COMPLETION_EVENTS.has(event.eventType)) continue;
    const candidateRef = digest(event.payload.candidateArtifactRef, "candidate artifact ref");
    const verdictRefs = exactVerdictDigests(envelope);
    if (candidateRef !== event.payload.candidateId) {
      throw new Error("invalid completion history: candidate artifact identity mismatch");
    }
    if (event.eventType === "completion.candidate.submitted.v1") {
      if (
        verdictRefs.length !== 0 ||
        event.payload.verdictArtifactRef !== null ||
        event.payload.admissionDecisionArtifactRef !== null ||
        !Number.isInteger(envelope.ledgerSeq) ||
        envelope.ledgerSeq < 1 ||
        !Number.isFinite(envelope.committedAtDbMs) ||
        envelope.committedAtDbMs < 0
      )
        throw new Error("invalid completion history: candidate stakes boundary is incomplete");
      if (state !== null) throw new Error("invalid completion history: candidate is immutable");
      state = Object.freeze({
        workItemId,
        candidateRef,
        status: "candidate",
        verdictRefs: Object.freeze([]),
        decisionRef: null,
        revision: 1,
        stakesAsOfLedgerSeq: envelope.ledgerSeq,
        stakesAsOfDbMs: envelope.committedAtDbMs,
      });
      continue;
    }
    if (state === null) throw new Error("invalid completion history: event before candidate");
    if (state.status !== "candidate")
      throw new Error("invalid completion history: event after decision");
    if (candidateRef !== state.candidateRef) {
      throw new Error("invalid completion history: candidate artifact identity mismatch");
    }
    if (event.eventType === "completion.claim_verdict_recorded.v1") {
      const verdictRef = digest(event.payload.verdictArtifactRef, "verdict artifact ref");
      const expectedRefs: string[] = [...state.verdictRefs, verdictRef];
      if (
        event.payload.admissionDecisionArtifactRef !== null ||
        state.verdictRefs.includes(verdictRef) ||
        !sameOrderedRefs(verdictRefs, expectedRefs)
      ) {
        throw new Error("invalid completion history: verdict coverage is not exact and ordered");
      }
      state = Object.freeze({
        ...state,
        verdictRefs: Object.freeze(expectedRefs),
        revision: state.revision + 1,
      });
    } else if (event.eventType === "completion.candidate_rejected.v1") {
      if (
        event.payload.verdictArtifactRef !== null ||
        event.payload.admissionDecisionArtifactRef !== null ||
        !sameOrderedRefs(verdictRefs, state.verdictRefs)
      ) {
        throw new Error(
          "invalid completion history: rejected candidate artifact refs are malformed",
        );
      }
      state = Object.freeze({
        ...state,
        status: "rejected",
        decisionRef: null,
        revision: state.revision + 1,
      });
    } else if (event.eventType === "completion.decision_recorded.v1") {
      const decisionRef = digest(
        event.payload.admissionDecisionArtifactRef,
        "admission decision artifact ref",
      );
      if (
        event.payload.verdictArtifactRef !== null ||
        state.verdictRefs.length === 0 ||
        !sameOrderedRefs(verdictRefs, state.verdictRefs)
      ) {
        throw new Error("invalid completion history: admission verdict coverage is not exact");
      }
      state = Object.freeze({
        ...state,
        status: "admitted",
        decisionRef,
        revision: state.revision + 1,
      });
    }
  }
  return state;
}
