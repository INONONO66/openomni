import { isDeepStrictEqual } from "node:util";
import { WorkItem } from "@openomni/protocol";
import { Storage } from "../storage/storage.js";
import { runAsCompletionWriter } from "./completion-writer.js";
import {
  appendTransitionFactReceipt,
  requireWorkItemLedger,
  runWorkItemTransaction,
} from "./facts.js";

export interface VerificationFactsInput {
  readonly expectedAttempt: number;
  /** Required for active writers; omission supports only pre-identity first-attempt callers. */
  readonly expectedAttemptId?: string;
  readonly expectedBasisRef: string;
  readonly observations: readonly WorkItem.Observation[];
  readonly results: readonly WorkItem.CriterionResult[];
  readonly verificationErrors: readonly WorkItem.VerificationErrorFact[];
  readonly evidence: readonly (Omit<WorkItem.Evidence, "attempt" | "basisRef" | "createdAt"> & {
    readonly id: string;
  })[];
  readonly verifierRef: string;
}

export type VerificationFactsOutcome =
  | { readonly kind: "appended"; readonly revision: number }
  | { readonly kind: "already_recorded" }
  | {
      readonly kind: "refused";
      readonly reason:
        | "unknown_item"
        | "attempt_closed"
        | "stale_attempt"
        | "stale_basis"
        | "identity_conflict"
        | "forbidden_shape";
    };

const equal = isDeepStrictEqual;

type ExistingIdentity =
  | { readonly kind: "fact"; readonly value: Readonly<{ id: string }> }
  | { readonly kind: "evidence"; readonly value: WorkItem.Evidence };

type SuppliedIdentity =
  | { readonly kind: "fact"; readonly value: Readonly<{ id: string }> }
  | { readonly kind: "evidence"; readonly value: VerificationFactsInput["evidence"][number] };

function existingIdentities(item: WorkItem.Info): readonly ExistingIdentity[] {
  return [
    ...[
      ...item.completionFacts.criteria,
      ...item.completionFacts.claims,
      ...item.completionFacts.observations,
      ...item.completionFacts.results,
      ...item.completionFacts.invalidations,
      ...item.completionFacts.verificationErrors,
      ...item.completionFacts.effects,
      ...item.completionFacts.requestReservations,
      ...item.completionFacts.admissions,
    ].map((value) => ({ kind: "fact" as const, value })),
    ...item.evidence.map((value) => ({ kind: "evidence" as const, value })),
  ];
}

function identityState(
  item: WorkItem.Info,
  input: VerificationFactsInput,
): "new" | "same" | "conflict" {
  const existing = new Map(existingIdentities(item).map((entry) => [entry.value.id, entry]));
  const supplied: readonly SuppliedIdentity[] = [
    ...input.observations.map((value) => ({ kind: "fact" as const, value })),
    ...input.results.map((value) => ({ kind: "fact" as const, value })),
    ...input.verificationErrors.map((value) => ({ kind: "fact" as const, value })),
    ...input.evidence.map((value) => ({ kind: "evidence" as const, value })),
  ];
  const present = supplied.map((entry) => existing.get(entry.value.id));
  if (present.every((entry) => entry === undefined)) return "new";
  if (present.some((entry) => entry === undefined)) return "conflict";
  const same = supplied.every((entry, index) => {
    const recorded = present[index];
    if (recorded === undefined || recorded.kind !== entry.kind) return false;
    if (recorded.kind === "evidence" && entry.kind === "evidence") {
      const {
        attempt: _attempt,
        basisRef: _basisRef,
        createdAt: _createdAt,
        ...shape
      } = recorded.value;
      return equal(shape, entry.value);
    }
    return equal(recorded.value, entry.value);
  });
  return same ? "same" : "conflict";
}

/** Fail-closed proof that the dedicated writer changed only its allowed projection paths. */
export function verificationFactsShapeViolation(
  existing: WorkItem.Info,
  candidate: WorkItem.Info,
): boolean {
  const unchangedTopLevel = {
    ...candidate,
    revision: existing.revision,
    completionFacts: existing.completionFacts,
    evidence: existing.evidence,
    timestamps: existing.timestamps,
  };
  const existingTopLevel = { ...existing };
  if (!equal(unchangedTopLevel, existingTopLevel)) return true;
  if (candidate.revision !== existing.revision + 1) return true;
  if (
    !equal(candidate.timestamps, { ...existing.timestamps, updated: candidate.timestamps.updated })
  ) {
    return true;
  }
  const current = existing.completionFacts;
  const next = candidate.completionFacts;
  if (next.revision !== current.revision + 1) return true;
  return !equal(
    {
      ...next,
      revision: current.revision,
      observations: current.observations,
      results: current.results,
      verificationErrors: current.verificationErrors,
    },
    current,
  );
}

function hasForbiddenFactShape(item: WorkItem.Info, input: VerificationFactsInput): boolean {
  if (
    input.observations.some(
      (fact) => fact.subjectRef !== item.workItemId || fact.basisRef !== input.expectedBasisRef,
    ) ||
    input.results.some(
      (fact) => fact.basisRef !== input.expectedBasisRef || fact.verifierRef !== input.verifierRef,
    ) ||
    input.verificationErrors.some(
      (fact) => fact.basisRef !== input.expectedBasisRef || fact.verifierRef !== input.verifierRef,
    )
  ) {
    return true;
  }
  const criterionIds = new Set(item.completionFacts.criteria.map((criterion) => criterion.id));
  return (
    input.results.some((fact) => !criterionIds.has(fact.criterionId)) ||
    input.verificationErrors.some((fact) => !criterionIds.has(fact.criterionId)) ||
    input.evidence.some(
      (fact) => fact.criterionId !== undefined && !criterionIds.has(fact.criterionId),
    )
  );
}

export function appendVerificationFacts(
  hash: string,
  input: VerificationFactsInput,
  _traceId: string,
): VerificationFactsOutcome {
  const storage = Storage.get();
  const adapter = storage.workItem;
  if (adapter === undefined) throw new Error("WorkItem storage is unavailable");
  const ledger = requireWorkItemLedger(storage);
  return runAsCompletionWriter(() =>
    runWorkItemTransaction(storage, hash, () => {
      const existing = adapter.get(hash);
      if (existing === undefined) return { kind: "refused", reason: "unknown_item" };
      if (existing.attemptTerminal !== undefined) {
        return { kind: "refused", reason: "attempt_closed" };
      }
      if (
        existing.lastAttemptSeq !== input.expectedAttempt ||
        existing.currentAttemptId === undefined ||
        (input.expectedAttemptId === undefined
          ? existing.lastAttemptSeq !== 1
          : existing.currentAttemptId !== input.expectedAttemptId)
      ) {
        return { kind: "refused", reason: "stale_attempt" };
      }
      if (existing.completionContract.basisRef !== input.expectedBasisRef) {
        return { kind: "refused", reason: "stale_basis" };
      }
      if (hasForbiddenFactShape(existing, input)) {
        return { kind: "refused", reason: "forbidden_shape" };
      }
      const identity = identityState(existing, input);
      if (identity === "same") return { kind: "already_recorded" };
      if (identity === "conflict") {
        return { kind: "refused", reason: "identity_conflict" };
      }
      const createdAt = Date.now();
      const candidateResult = WorkItem.Info.safeParse({
        ...existing,
        revision: existing.revision + 1,
        completionFacts: {
          ...existing.completionFacts,
          revision: existing.completionFacts.revision + 1,
          observations: [...existing.completionFacts.observations, ...input.observations],
          results: [...existing.completionFacts.results, ...input.results],
          verificationErrors: [
            ...existing.completionFacts.verificationErrors,
            ...input.verificationErrors,
          ],
        },
        evidence: [
          ...existing.evidence,
          ...input.evidence.map((fact) => ({
            ...fact,
            attempt: input.expectedAttempt,
            basisRef: input.expectedBasisRef,
            createdAt,
          })),
        ],
        timestamps: { ...existing.timestamps, updated: createdAt },
      });
      if (
        !candidateResult.success ||
        verificationFactsShapeViolation(existing, candidateResult.data)
      ) {
        return { kind: "refused", reason: "forbidden_shape" };
      }
      const candidate = candidateResult.data;
      const recorded = appendTransitionFactReceipt(
        ledger,
        existing,
        {
          type: "work_item.verification_recorded",
          data: {
            basisRef: input.expectedBasisRef,
            attempt: input.expectedAttempt,
            verifierRef: input.verifierRef,
            resultIds: input.results.map((fact) => fact.id),
            observationIds: input.observations.map((fact) => fact.id),
            verificationErrorIds: input.verificationErrors.map((fact) => fact.id),
            evidenceIds: input.evidence.map((fact) => fact.id),
          },
        },
        () => adapter.compareAndSet(hash, existing.revision, candidate),
        (unit) => storage.transaction(unit),
      );
      return recorded
        ? { kind: "appended", revision: candidate.revision }
        : { kind: "refused", reason: "stale_attempt" };
    }),
  );
}
