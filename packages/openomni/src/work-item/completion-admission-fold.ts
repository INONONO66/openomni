import { WorkItem } from "@openomni/protocol";

export type CompletionPolicy = Readonly<{
  policyRef: string;
  verdict: "allow" | "deny" | "pending";
  allowedAssertedCriterionIds: readonly string[];
  reasonCodes: readonly string[];
}>;

export type CompletionProposedFacts = Omit<
  WorkItem.CompletionFacts,
  "version" | "revision" | "criteria" | "requestReservations" | "admissions"
>;

type OwnerOverride = Readonly<{
  receiptRef: string;
  workItemHash: string;
  requestId: string;
  contractRevision: string;
  basisRef: string;
}>;

export type CompletionEvaluationInput = Readonly<{
  admissionId: string;
  requestId: string;
  requestRoot: string;
  sourceIdentity?: WorkItem.CompletionSourceIdentity;
  origin: WorkItem.CompletionOrigin;
  workItemHash: string;
  contractRevision: string;
  basisRef: string;
  expectedHead: number;
  createdAt: number;
  durableFacts: WorkItem.CompletionFacts;
  proposedFacts: CompletionProposedFacts;
  blockers: readonly WorkItem.Blocker[];
  currentAttempt: number;
  policy: CompletionPolicy;
  stakes?: Readonly<{
    ref: string;
    comparison: "below" | "at" | "above";
  }>;
  ownerOverride?: OwnerOverride;
}>;

type CompletionFoldErrorCode =
  | "duplicate_fact_id"
  | "dangling_criterion_reference"
  | "dangling_observation_reference"
  | "dangling_result_reference"
  | "invalid_owner_override_binding"
  | "invalid_policy_verdict";

class CompletionFoldError extends Error {
  readonly name = "CompletionFoldError";

  constructor(
    readonly code: CompletionFoldErrorCode,
    readonly factId: string,
    readonly referenceId: string,
  ) {
    super(`${code}: ${factId} -> ${referenceId}`);
  }
}

type FoldFacts = Readonly<{
  criteria: readonly WorkItem.Criterion[];
  claims: readonly WorkItem.Claim[];
  observations: readonly WorkItem.Observation[];
  results: readonly WorkItem.CriterionResult[];
  invalidations: readonly WorkItem.ResultInvalidation[];
  verificationErrors: readonly WorkItem.VerificationErrorFact[];
  effects: readonly WorkItem.EffectRecord[];
}>;

type FoldState = {
  readonly effectiveResultIds: string[];
  readonly unresolvedCriterionIds: string[];
  readonly reasonCodes: string[];
  readonly residualRisks: string[];
  highRiskAsserted: boolean;
  hasBlockingResult: boolean;
  policyBlocked: boolean;
};

export function evaluateCompletion(input: CompletionEvaluationInput): WorkItem.CompletionAdmission {
  const facts = mergeFacts(input);
  assertOwnerOverrideBinding(input);
  assertFactGraph(
    input.admissionId,
    input.durableFacts.requestReservations,
    input.durableFacts.admissions,
    facts,
  );

  const state = foldRequiredCriteria(input, facts);
  foldResolvedPolicy(input.policy, state);
  if (input.blockers.some((blocker) => blocker.resolvedAt === undefined)) {
    addUnique(state.reasonCodes, "active_blocker");
    state.hasBlockingResult = true;
  }
  const latestEffectsByIntent = new Map<string, WorkItem.EffectRecord>();
  for (const effect of facts.effects) {
    if (effect.attempt !== input.currentAttempt) continue;
    const latest = latestEffectsByIntent.get(effect.intentRef);
    if (!latest || compareOutcome(effect, latest) > 0) {
      latestEffectsByIntent.set(effect.intentRef, effect);
    }
  }
  const hasUnresolvedEffect = [...latestEffectsByIntent.values()].some(
    (effect) => effect.outcome === undefined || effect.outcome === "unknown",
  );
  if (hasUnresolvedEffect) {
    addUnique(state.reasonCodes, "effect_outcome_unresolved");
    state.hasBlockingResult = true;
  }

  const decision = resolveDecision(input, state);
  return WorkItem.CompletionAdmission.parse({
    version: 1,
    id: input.admissionId,
    requestId: input.requestId,
    workItemHash: input.workItemHash,
    sourceIdentity: input.sourceIdentity,
    requestRoot: input.requestRoot,
    proposedFactIds: {
      claims: input.proposedFacts.claims.map(({ id }) => id),
      observations: input.proposedFacts.observations.map(({ id }) => id),
      results: input.proposedFacts.results.map(({ id }) => id),
      invalidations: input.proposedFacts.invalidations.map(({ id }) => id),
      verificationErrors: input.proposedFacts.verificationErrors.map(({ id }) => id),
      effects: input.proposedFacts.effects.map(({ id }) => id),
    },
    origin: input.origin,
    contractRevision: input.contractRevision,
    basisRef: input.basisRef,
    effectiveResultIds: state.effectiveResultIds,
    unresolvedCriterionIds: state.unresolvedCriterionIds,
    decision,
    reasonCodes: state.reasonCodes,
    residualRisks: state.residualRisks,
    policyRef: input.policy.policyRef,
    stakesRef: input.stakes?.ref,
    ownerOverrideReceiptRef: input.ownerOverride?.receiptRef,
    expectedHead: input.expectedHead,
    recordedHead: input.expectedHead + 1,
    createdAt: input.createdAt,
  });
}

function mergeFacts(input: CompletionEvaluationInput): FoldFacts {
  const { durableFacts, proposedFacts } = input;
  return {
    criteria: [...durableFacts.criteria],
    claims: [...durableFacts.claims, ...proposedFacts.claims],
    observations: [...durableFacts.observations, ...proposedFacts.observations],
    results: [...durableFacts.results, ...proposedFacts.results],
    invalidations: [...durableFacts.invalidations, ...proposedFacts.invalidations],
    verificationErrors: [...durableFacts.verificationErrors, ...proposedFacts.verificationErrors],
    effects: [...durableFacts.effects, ...proposedFacts.effects],
  };
}

function assertFactGraph(
  admissionId: string,
  reservations: readonly WorkItem.CompletionRequestReservation[],
  admissions: readonly WorkItem.CompletionAdmission[],
  facts: FoldFacts,
): void {
  const identified = [
    ...facts.criteria,
    ...facts.claims,
    ...facts.observations,
    ...facts.results,
    ...facts.invalidations,
    ...facts.verificationErrors,
    ...facts.effects,
    ...reservations,
    ...admissions,
  ];
  const ids = new Set<string>();
  for (const fact of identified) {
    if (ids.has(fact.id)) throw new CompletionFoldError("duplicate_fact_id", fact.id, fact.id);
    ids.add(fact.id);
  }
  if (ids.has(admissionId)) {
    throw new CompletionFoldError("duplicate_fact_id", admissionId, admissionId);
  }

  const criterionIds = new Set(facts.criteria.map((criterion) => criterion.id));
  const observationIds = new Set(facts.observations.map((observation) => observation.id));
  const resultIds = new Set(facts.results.map((result) => result.id));
  for (const claim of facts.claims) {
    assertReference("criterion", claim.id, claim.criterionId, criterionIds);
    for (const observationId of claim.observationIds) {
      assertReference("observation", claim.id, observationId, observationIds);
    }
  }
  for (const observation of facts.observations) {
    for (const ancestryRef of observation.ancestryRefs) {
      assertReference("observation", observation.id, ancestryRef, observationIds);
    }
  }
  for (const result of facts.results) {
    assertReference("criterion", result.id, result.criterionId, criterionIds);
    for (const observationId of result.observationIds) {
      assertReference("observation", result.id, observationId, observationIds);
    }
  }
  for (const invalidation of facts.invalidations) {
    assertReference("result", invalidation.id, invalidation.resultId, resultIds);
  }
  for (const error of facts.verificationErrors) {
    assertReference("criterion", error.id, error.criterionId, criterionIds);
  }
  for (const admission of admissions) {
    for (const criterionId of admission.unresolvedCriterionIds) {
      assertReference("criterion", admission.id, criterionId, criterionIds);
    }
    for (const resultId of admission.effectiveResultIds) {
      assertReference("result", admission.id, resultId, resultIds);
    }
  }
}

function assertReference(
  kind: "criterion" | "observation" | "result",
  factId: string,
  referenceId: string,
  knownIds: ReadonlySet<string>,
): void {
  if (!knownIds.has(referenceId)) {
    throw new CompletionFoldError(`dangling_${kind}_reference`, factId, referenceId);
  }
}

function assertOwnerOverrideBinding(input: CompletionEvaluationInput): void {
  const override = input.ownerOverride;
  if (!override) return;
  if (
    override.workItemHash !== input.workItemHash ||
    override.requestId !== input.requestId ||
    override.contractRevision !== input.contractRevision ||
    override.basisRef !== input.basisRef
  ) {
    throw new CompletionFoldError(
      "invalid_owner_override_binding",
      override.receiptRef,
      input.workItemHash,
    );
  }
}

function foldRequiredCriteria(input: CompletionEvaluationInput, facts: FoldFacts): FoldState {
  const state: FoldState = {
    effectiveResultIds: [],
    unresolvedCriterionIds: [],
    reasonCodes: [],
    residualRisks: [],
    highRiskAsserted: false,
    hasBlockingResult: false,
    policyBlocked: false,
  };
  const invalidatedIds = new Set(
    facts.invalidations
      .filter((entry) => entry.basisRef === input.basisRef)
      .map((entry) => entry.resultId),
  );
  if (input.proposedFacts.results.some((result) => result.basisRef !== input.basisRef)) {
    addUnique(state.reasonCodes, "basis_mismatch");
    state.hasBlockingResult = true;
  }

  for (const criterion of facts.criteria) {
    if (!criterion.required) continue;
    const criterionResults = facts.results.filter((result) => result.criterionId === criterion.id);
    const currentResults = criterionResults.filter(
      (result) => result.basisRef === input.basisRef && !invalidatedIds.has(result.id),
    );
    if (
      criterionResults.some(
        (result) => result.basisRef === input.basisRef && invalidatedIds.has(result.id),
      )
    ) {
      addUnique(state.reasonCodes, "result_invalidated");
    }
    const selected = selectResult(currentResults);
    const latestError = selectLatest(
      facts.verificationErrors.filter(
        (error) => error.criterionId === criterion.id && error.basisRef === input.basisRef,
      ),
    );
    if (latestError && (!selected || compareOutcome(latestError, selected) >= 0)) {
      addUnique(state.unresolvedCriterionIds, criterion.id);
      addUnique(state.reasonCodes, "verification_error");
      state.hasBlockingResult = true;
      continue;
    }
    if (!selected) {
      addUnique(state.unresolvedCriterionIds, criterion.id);
      addUnique(state.reasonCodes, "required_result_missing");
      state.hasBlockingResult = true;
      continue;
    }
    state.effectiveResultIds.push(selected.id);
    foldSelectedResult(criterion, selected, input, state);
  }
  return state;
}

function foldSelectedResult(
  criterion: WorkItem.Criterion,
  result: WorkItem.CriterionResult,
  input: CompletionEvaluationInput,
  state: FoldState,
): void {
  switch (result.value) {
    case "verified":
      return;
    case "refuted":
      addUnique(state.unresolvedCriterionIds, criterion.id);
      addUnique(state.reasonCodes, "required_result_refuted");
      state.hasBlockingResult = true;
      return;
    case "inconclusive":
      addUnique(state.unresolvedCriterionIds, criterion.id);
      addUnique(state.reasonCodes, "required_result_inconclusive");
      state.hasBlockingResult = true;
      return;
    case "asserted":
      state.residualRisks.push(...result.residualRisks);
      if (input.stakes?.comparison === "at" || input.stakes?.comparison === "above") {
        addUnique(state.unresolvedCriterionIds, criterion.id);
        state.highRiskAsserted = true;
        addUnique(state.reasonCodes, "high_risk_asserted");
        return;
      }
      if (
        input.stakes?.comparison === "below" &&
        input.policy.allowedAssertedCriterionIds.includes(criterion.id)
      ) {
        addUnique(state.reasonCodes, "low_risk_asserted_allowed");
        return;
      }
      addUnique(state.unresolvedCriterionIds, criterion.id);
      if (input.stakes?.comparison === "below") {
        addUnique(state.reasonCodes, "low_risk_asserted_not_allowed");
        state.hasBlockingResult = true;
        return;
      }
      state.highRiskAsserted = true;
      addUnique(state.reasonCodes, "high_risk_asserted");
      if (!input.stakes) {
        addUnique(state.reasonCodes, "stakes_required");
        state.hasBlockingResult = true;
      }
  }
}

function foldResolvedPolicy(policy: CompletionPolicy, state: FoldState): void {
  for (const reasonCode of policy.reasonCodes) addUnique(state.reasonCodes, reasonCode);
  switch (policy.verdict) {
    case "allow":
      return;
    case "deny":
      if (policy.reasonCodes.length === 0) addUnique(state.reasonCodes, "policy_denied");
      state.policyBlocked = true;
      state.hasBlockingResult = true;
      return;
    case "pending":
      if (policy.reasonCodes.length === 0) addUnique(state.reasonCodes, "policy_pending");
      state.policyBlocked = true;
      state.hasBlockingResult = true;
      return;
  }
  assertNever(policy.verdict);
}

function resolveDecision(
  input: CompletionEvaluationInput,
  state: FoldState,
): WorkItem.CompletionDecision {
  if (input.ownerOverride) return "owner_override";
  if (state.policyBlocked) return "block";
  if (state.hasBlockingResult) return "block";
  if (state.highRiskAsserted) return "escalate";
  if (state.unresolvedCriterionIds.length > 0) return "block";
  return "admit";
}

function selectResult(
  results: readonly WorkItem.CriterionResult[],
): WorkItem.CriterionResult | undefined {
  const authoritative = results.filter(({ value }) => value !== "asserted");
  return selectLatest(authoritative.length > 0 ? authoritative : results);
}

function selectLatest<T extends Readonly<{ id: string; createdAt: number }>>(
  facts: readonly T[],
): T | undefined {
  return [...facts].sort((left, right) => compareOutcome(right, left))[0];
}

function compareOutcome(
  left: Readonly<{ id: string; createdAt: number }>,
  right: Readonly<{ id: string; createdAt: number }>,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function assertNever(value: never): never {
  throw new CompletionFoldError("invalid_policy_verdict", "policy", String(value));
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
