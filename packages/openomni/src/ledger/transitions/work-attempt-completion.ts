import type { Execution, Ledger } from "@openomni/protocol";
import type { KernelTransitionCommandV1 } from "../ports.js";
import { attemptIsTerminal, reduceAttemptProjections } from "../reducers/attempt.js";
import { reduceCompletionProjection } from "../reducers/completion.js";
import { reduceWorkProjection } from "../reducers/work.js";

const WORK_IDS = new Set(
  Array.from({ length: 17 }, (_, index) => `WI-${String(index + 1).padStart(2, "0")}`),
);
const ATTEMPT_IDS = new Set(
  Array.from({ length: 15 }, (_, index) => `AT-${String(index + 1).padStart(2, "0")}`),
);
const COMPLETION_IDS = new Set(
  Array.from({ length: 4 }, (_, index) => `CP-${String(index + 1).padStart(2, "0")}`),
);

function commandRef(command: KernelTransitionCommandV1): string {
  const payload = command.payload as {
    readonly workSnapshotRef?: { readonly digest: string };
    readonly attemptSnapshotRef?: { readonly digest: string };
  };
  return (
    payload.workSnapshotRef?.digest ?? payload.attemptSnapshotRef?.digest ?? command.requestHash
  );
}

function sameOrderedRefs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function completionFacts(
  command: KernelTransitionCommandV1,
): Execution.NativeTransitionPayloadV1["facts"]["CP"] | undefined {
  return "facts" in command.payload ? command.payload.facts.CP : undefined;
}

function isWorkTerminal(status: string): boolean {
  return status === "completed" || status === "archived";
}
function authoritativeBindingReason(
  command: KernelTransitionCommandV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): string | null {
  if (!("facts" in command.payload)) return null;
  const facts = command.payload.facts as Execution.NativeTransitionPayloadV1["facts"];
  const { WI, AT, CP, EF } = facts;
  const workItemId =
    WI?.workItemId ?? AT?.attempt.workItemId ?? CP?.workItemId ?? EF?.attempt.workItemId;
  if (workItemId === undefined || command.payload.owner.ownerKey !== `work:${workItemId}`) {
    return "work_owner_binding_mismatch";
  }
  if (WI !== undefined && (WI.subjectId !== WI.workItemId || WI.workItemId !== workItemId)) {
    return "work_identity_mismatch";
  }
  if (
    command.transitionId === "WI-01" &&
    (ownerEvents.length !== 0 || command.expectedHead.ownerSeq !== 0)
  ) {
    return "work_genesis_required";
  }
  if (command.transitionId === "WI-01" && (WI === undefined || WI.workSnapshotRef.byteLength < 1)) {
    return "nonempty_persisted_criteria_required";
  }
  if (AT !== undefined) {
    if (
      AT.subjectId !== AT.attempt.attemptId ||
      AT.attempt.workItemId !== workItemId ||
      AT.runBinding.workItemId !== workItemId ||
      AT.runBinding.attemptId !== AT.attempt.attemptId
    )
      return "attempt_binding_mismatch";
    const allocation = ownerEvents.find(
      ({ event }) =>
        event.eventType === "attempt.allocated.v1" &&
        event.payload.attemptId === AT.attempt.attemptId,
    )?.event.payload;
    if (
      command.transitionId !== "AT-01" &&
      command.transitionId !== "WI-12" &&
      (allocation === undefined ||
        allocation.workItemId !== AT.attempt.workItemId ||
        allocation.attemptSeq !== AT.attempt.attemptSeq ||
        allocation.sessionId !== AT.runBinding.sessionId ||
        allocation.runId !== AT.runBinding.runId ||
        allocation.model?.provider !== AT.model.provider ||
        allocation.model?.id !== AT.model.id ||
        allocation.environmentSnapshotRef?.digest !== AT.environmentSnapshotRef.digest)
    )
      return "immutable_attempt_binding_mismatch";
  }
  if (CP !== undefined) {
    if (CP.subjectId !== workItemId || CP.workItemId !== workItemId) {
      return "completion_work_binding_mismatch";
    }
    if (
      CP.runBinding.workItemId !== workItemId ||
      (command.transitionId === "CP-01" &&
        (CP.runBinding.attemptId !== command.identity.attemptId ||
          CP.runBinding.sessionId !== command.identity.sessionId ||
          CP.runBinding.runId !== command.identity.runId))
    )
      return "completion_run_binding_mismatch";
    const allocation = ownerEvents.find(
      ({ event }) =>
        event.eventType === "attempt.allocated.v1" &&
        event.payload.attemptId === CP.runBinding.attemptId,
    )?.event.payload;
    if (
      allocation === undefined ||
      allocation.workItemId !== workItemId ||
      allocation.sessionId !== CP.runBinding.sessionId ||
      allocation.runId !== CP.runBinding.runId
    )
      return "completion_attempt_not_authoritative";
  }
  if (EF !== undefined) {
    if (EF.subjectId !== EF.effect.effectId || EF.attempt.workItemId !== workItemId) {
      return "effect_binding_mismatch";
    }
    if (
      AT !== undefined &&
      (EF.attempt.attemptId !== AT.attempt.attemptId ||
        EF.attempt.attemptSeq !== AT.attempt.attemptSeq)
    )
      return "effect_attempt_binding_mismatch";
  }
  return null;
}

/** Returns null when the family edge is valid, otherwise a stable guard reason. */
function attemptRefForCommand(command: KernelTransitionCommandV1): Ledger.AttemptRefV1 | undefined {
  if ("attempt" in command.payload && command.payload.attempt !== undefined) {
    return command.payload.attempt;
  }
  if ("facts" in command.payload) {
    return command.payload.facts.AT?.attempt ?? command.payload.facts.EF?.attempt;
  }
  return undefined;
}

export function workAttemptCompletionGuardReason(
  command: KernelTransitionCommandV1,
  ownerEvents: readonly Ledger.EnvelopeV1[],
): string | null {
  const id = command.transitionId;
  if (!WORK_IDS.has(id) && !ATTEMPT_IDS.has(id) && !COMPLETION_IDS.has(id)) return null;
  const bindingReason = authoritativeBindingReason(command, ownerEvents);
  if (bindingReason !== null) return bindingReason;

  const claimedAttempt = attemptRefForCommand(command);
  const workItemId =
    ATTEMPT_IDS.has(id) && claimedAttempt !== undefined
      ? claimedAttempt.workItemId
      : command.payload.subjectId;
  const work = reduceWorkProjection(workItemId, ownerEvents);
  const attempts = reduceAttemptProjections(ownerEvents);
  const completion = reduceCompletionProjection(workItemId, ownerEvents);
  const attempt = claimedAttempt === undefined ? undefined : attempts.get(claimedAttempt.attemptId);
  const ref = commandRef(command);

  if (id === "WI-01") return work === null ? null : "work_already_exists";
  if (work === null) return "work_not_found";
  if (isWorkTerminal(work.status)) return "work_is_terminal";

  switch (id) {
    case "WI-02":
    case "WI-03":
    case "WI-04":
    case "WI-16":
    case "WI-17":
      return null;
    case "WI-05":
      return [...attempts.values()].some((item) => item.status === "allocated")
        ? null
        : "allocated_attempt_required";
    case "WI-06":
      return work.evidenceRefs.includes(ref) ? "duplicate_evidence" : null;
    case "WI-07":
      return work.readbackRefs.includes(ref) ? "duplicate_readback" : null;
    case "WI-08":
      return work.activeBlockerRefs.includes(ref) ? "duplicate_active_blocker" : null;
    case "WI-09":
      return work.activeBlockerRefs.includes(ref) ? null : "active_blocker_required";
    case "WI-10":
    case "WI-11":
      return work.status === "failed" || work.status === "cancelled"
        ? "work_already_stopped"
        : null;
    case "WI-12": {
      if (!("attempt" in command.payload) || command.payload.attempt === undefined)
        return "attempt_ref_required";
      const ordered = [...attempts.values()].sort((a, b) => a.attemptSeq - b.attemptSeq);
      const prior = ordered.at(-1);
      if (prior === undefined || !attemptIsTerminal(prior))
        return "terminal_retry_predecessor_required";
      if (command.payload.attempt.attemptSeq !== prior.attemptSeq + 1)
        return "attempt_sequence_conflict";
      if (attempts.has(command.payload.attempt.attemptId)) return "attempt_already_exists";
      if (work.retryExhausted) return "retry_budget_exhausted";
      return null;
    }
    case "WI-13":
      return work.retryExhausted ? "retry_already_exhausted" : null;
    case "WI-14":
      if (work.outcomeRef !== null) return "outcome_immutable";
      return attempt !== undefined && attemptIsTerminal(attempt)
        ? null
        : "terminal_attempt_required";
    case "WI-15":
      return [...attempts.values()].some((item) => !attemptIsTerminal(item))
        ? "active_attempt_exists"
        : null;
    case "CP-01": {
      const facts = completionFacts(command);
      if (facts === undefined) return "completion_facts_required";
      if (
        facts.candidateArtifactRef.digest !== facts.candidateId ||
        facts.verdictArtifactRef !== null ||
        facts.admissionDecisionArtifactRef !== null ||
        facts.verdictArtifactRefs.length !== 0
      )
        return "candidate_artifact_identity_mismatch";
      return completion === null ? null : "candidate_immutable";
    }
    case "CP-02": {
      if (completion === null || completion.status !== "candidate")
        return "active_candidate_required";
      const facts = completionFacts(command);
      if (facts === undefined) return "completion_facts_required";
      if (
        facts.candidateId !== completion.candidateRef ||
        facts.candidateArtifactRef.digest !== completion.candidateRef
      )
        return "candidate_artifact_identity_mismatch";
      if (facts.verdictArtifactRef === null || facts.admissionDecisionArtifactRef !== null)
        return "claim_verdict_artifact_required";
      const verdictRef = facts.verdictArtifactRef.digest;
      if (completion.verdictRefs.includes(verdictRef)) return "claim_verdict_immutable";
      return sameOrderedRefs(
        facts.verdictArtifactRefs.map((artifactRef) => artifactRef.digest),
        [...completion.verdictRefs, verdictRef],
      )
        ? null
        : "claim_verdict_coverage_mismatch";
    }
    case "CP-03": {
      if (completion === null || completion.status !== "candidate")
        return "active_candidate_required";
      const facts = completionFacts(command);
      if (facts === undefined) return "completion_facts_required";
      return facts.candidateId === completion.candidateRef &&
        facts.candidateArtifactRef.digest === completion.candidateRef &&
        facts.verdictArtifactRef === null &&
        facts.admissionDecisionArtifactRef === null &&
        sameOrderedRefs(
          facts.verdictArtifactRefs.map((artifactRef) => artifactRef.digest),
          completion.verdictRefs,
        )
        ? null
        : "completion_artifact_identity_mismatch";
    }
    case "CP-04": {
      if (completion === null || completion.status !== "candidate")
        return "active_candidate_required";
      const facts = completionFacts(command);
      if (facts === undefined) return "completion_facts_required";
      if (
        facts.candidateId !== completion.candidateRef ||
        facts.candidateArtifactRef.digest !== completion.candidateRef
      )
        return "candidate_artifact_identity_mismatch";
      if (facts.verdictArtifactRef !== null || facts.admissionDecisionArtifactRef === null)
        return "admission_decision_artifact_required";
      if (
        completion.verdictRefs.length === 0 ||
        new Set(completion.verdictRefs).size !== completion.verdictRefs.length ||
        !sameOrderedRefs(
          facts.verdictArtifactRefs.map((artifactRef) => artifactRef.digest),
          completion.verdictRefs,
        )
      )
        return "complete_verdict_coverage_required";
      if (
        !Number.isInteger(completion.stakesAsOfLedgerSeq) ||
        completion.stakesAsOfLedgerSeq < 1 ||
        !Number.isFinite(completion.stakesAsOfDbMs) ||
        completion.stakesAsOfDbMs < 0
      )
        return "candidate_stakes_boundary_required";
      if (work.activeBlockerRefs.length > 0) return "active_blockers_prevent_completion";
      return null;
    }
  }

  if (ATTEMPT_IDS.has(id)) {
    if (claimedAttempt === undefined) return "attempt_ref_required";
    const claimed = claimedAttempt;
    if (
      claimed.workItemId !== workItemId ||
      (id !== "AT-12" && claimed.attemptId !== command.payload.subjectId)
    ) {
      return "attempt_binding_mismatch";
    }
    if (id === "AT-01") {
      if (attempt !== undefined) return "attempt_already_exists";
      const expectedSeq = attempts.size + 1;
      if (claimed.attemptSeq !== expectedSeq) return "attempt_sequence_conflict";
      const prior = [...attempts.values()].find((item) => item.attemptSeq === expectedSeq - 1);
      return prior === undefined || attemptIsTerminal(prior)
        ? null
        : "terminal_retry_predecessor_required";
    }
    if (attempt === undefined || attempt.attemptSeq !== claimed.attemptSeq)
      return "attempt_not_found";
    switch (id) {
      case "AT-02":
        return attempt.status === "allocated" ? null : "allocated_attempt_required";
      case "AT-03":
      case "AT-04":
      case "AT-05": {
        const allowedStatus =
          id === "AT-03"
            ? attempt.status === "starting" || attempt.status === "waiting"
            : id === "AT-04"
              ? attempt.status === "starting"
              : attempt.status === "starting" || attempt.status === "running";
        if (!allowedStatus)
          return id === "AT-04" ? "starting_attempt_required" : "pending_effect_required";
        if (!("facts" in command.payload)) {
          return ownerEvents.some(
            ({ event }) =>
              event.eventType === "effect.intent.v1" &&
              event.payload.subjectId === claimed.attemptId,
          )
            ? null
            : "confirmed_effect_requires_intent";
        }
        const effect = (command.payload.facts as Execution.NativeTransitionPayloadV1["facts"]).EF;
        if (effect === undefined) return "effect_facts_required";
        const hasIntent = ownerEvents.some(
          ({ event }) =>
            event.eventType === "effect.intent.v1" &&
            event.payload.subjectId === effect.effect.effectId &&
            event.payload.effectId === effect.effect.effectId &&
            event.payload.idempotencyKey === effect.effect.idempotencyKey &&
            event.payload.effectScopeRef?.digest === effect.effectScopeRef.digest &&
            event.payload.workItemId === claimed.workItemId &&
            event.payload.attemptId === claimed.attemptId,
        );
        return hasIntent ? null : "confirmed_effect_requires_intent";
      }
      case "AT-06":
        return attempt.status === "starting" ? null : "starting_attempt_required";
      case "AT-07":
      case "AT-08":
      case "AT-09":
      case "AT-10":
      case "AT-11":
        return attempt.status === "running" ? null : "running_attempt_required";
      case "AT-12":
      case "AT-14":
      case "AT-15":
        return attempt.status === "waiting" ? null : "waiting_attempt_required";
      case "AT-13": {
        if (attempt.status !== "waiting") return "waiting_attempt_required";
        if (!("facts" in command.payload)) return "effect_facts_required";
        const effect = command.payload.facts.EF;
        if (effect === undefined || effect.settlement !== "definite_failed")
          return "effect_facts_required";
        const hasIntent = ownerEvents.some(
          ({ event }) =>
            event.eventType === "effect.intent.v1" &&
            event.payload.subjectId === effect.effect.effectId &&
            event.payload.effectId === effect.effect.effectId &&
            event.payload.idempotencyKey === effect.effect.idempotencyKey &&
            event.payload.effectScopeRef?.digest === effect.effectScopeRef.digest &&
            event.payload.workItemId === claimed.workItemId &&
            event.payload.attemptId === claimed.attemptId,
        );
        return hasIntent ? null : "confirmed_effect_requires_intent";
      }
    }
  }
  return "unknown_family_edge";
}

/** Attempt events always project under the immutable attempt identity, including WI-12 retry batches. */
export function workAttemptCompletionEventSubject(
  command: KernelTransitionCommandV1,
  eventType: Ledger.NativeEventTypeV1,
): string {
  if (eventType.startsWith("attempt.")) {
    return attemptRefForCommand(command)?.attemptId ?? command.payload.subjectId;
  }
  return command.payload.subjectId;
}
