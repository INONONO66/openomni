import type { PolicyEngine } from "@openomni/policy";
import { WorkItem, type Policy } from "@openomni/protocol";
import { Bus, Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { VerifierRegistry } from "../evidence/verifier-registry.js";
import type { CompletionStakesInjection } from "../ledger/index.js";
import {
  evaluateCompletion as foldCompletion,
  type CompletionEvaluationInput,
  type CompletionPolicy,
  type CompletionProposedFacts,
} from "./completion-admission-fold.js";

export type CompletionAdmissionErrorCode =
  | "invalid_subject"
  | "stale_basis"
  | "stale_head"
  | "duplicate_fact_id"
  | "invalid_verifier"
  | "unsupported_fact"
  | "authority_unavailable"
  | "admission_required"
  | "request_conflict"
  | "terminal_state";

export class CompletionAdmissionError extends Error {
  readonly name = "CompletionAdmissionError";

  constructor(
    readonly code: CompletionAdmissionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function canonicalCompletionRequest(input: WorkItem.CompletionRequest): WorkItem.CompletionRequest {
  const request = WorkItem.CompletionRequest.parse(input);
  return WorkItem.CompletionRequest.parse({
    ...request,
    claims: sortFacts(request.claims.map(canonicalClaim)),
    observations: sortFacts(request.observations.map(canonicalObservation)),
    results: sortFacts(request.results.map(canonicalResult)),
    invalidations: sortFacts(request.invalidations),
    verificationErrors: sortFacts(request.verificationErrors),
    effects: sortFacts(request.effects),
  });
}

export function completionRequestRoot(input: WorkItem.CompletionRequest): string {
  const { expectedHead: _expectedHead, ...request } = canonicalCompletionRequest(input);
  return WorkItem.sha256JsonRef(request);
}

function completionRequestEnvelopeDigest(requestRoot: string, completionReportRef: string): string {
  return WorkItem.sha256JsonRef({ requestRoot, completionReportRef });
}

export function completionReportsMatch(
  left: WorkItem.CompletionReport,
  right: WorkItem.CompletionReport,
): boolean {
  return WorkItem.completionReportReference(left) === WorkItem.completionReportReference(right);
}

function canonicalClaim(claim: WorkItem.Claim): WorkItem.Claim {
  return { ...claim, observationIds: sortReferences(claim.observationIds) };
}

function canonicalObservation(observation: WorkItem.Observation): WorkItem.Observation {
  return {
    ...observation,
    artifactRefs: sortReferences(observation.artifactRefs),
    ancestryRefs: sortReferences(observation.ancestryRefs),
  };
}

function canonicalResult(result: WorkItem.CriterionResult): WorkItem.CriterionResult {
  return {
    ...result,
    observationIds: sortReferences(result.observationIds),
    assumptions: sortReferences(result.assumptions),
    residualRisks: sortReferences(result.residualRisks),
  };
}

function sortFacts<T extends Readonly<{ id: string }>>(facts: readonly T[]): T[] {
  return [...facts].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function sortReferences(references: readonly string[]): string[] {
  return [...new Set(references)].sort();
}

type WorkItemAdapter = NonNullable<ReturnType<typeof Storage.get>["workItem"]>;

type CompletionRequestReservationInput = Readonly<{
  completionWriter: Storage.WorkItemCompletionWriter;
  workItemHash: string;
  requestId: string;
  requestRoot: string;
  envelopeDigest: string;
  ownerId: string;
  leaseDurationMs: number;
  now: number;
  forceTakeover?: boolean;
}>;

export type CompletionRequestReservationOutcome = Readonly<{
  state: "reserved" | "existing" | "busy" | "admitted";
  reservation: WorkItem.CompletionRequestReservation;
}>;

type CompletionReservationLeaseInput = Readonly<{
  workItemHash: string;
  requestId: string;
  reservationId: string;
  ownerId: string;
  fence: number;
  now: number;
}>;

type CompletionReservationOptions = Readonly<{
  ownerId?: string;
  leaseDurationMs?: number;
  requestRoot?: string;
  envelopeDigest?: string;
}>;

type ResolvedCompletionReservation = Readonly<{
  ownerId: string;
  leaseDurationMs: number;
  requestRoot?: string;
  envelopeDigest?: string;
}>;

type CompletionRequestIdentity = Readonly<{
  id: string;
  requestRoot: string;
  envelopeDigest: string;
}>;

type CompletionReservationAssertion = (() => void) &
  Readonly<{
    state: "reserved" | "existing";
    recordedHead: number;
  }>;

const CompletionCasRetryLimit = 8;
const DefaultCompletionLeaseDurationMs = 15_000;

export function reserveCompletionRequest(
  input: CompletionRequestReservationInput,
): CompletionRequestReservationOutcome {
  return reserveCompletionRequestWithLimit(input, CompletionCasRetryLimit);
}

function reserveCompletionRequestWithLimit(
  input: CompletionRequestReservationInput,
  retryLimit: number,
): CompletionRequestReservationOutcome {
  const adapter = requiredAdapter(input.workItemHash);
  for (let attempt = 0; attempt < retryLimit; attempt += 1) {
    const current = requiredItem(adapter.get(input.workItemHash), input.workItemHash);
    const reservation = current.completionFacts.requestReservations
      .filter(({ requestId }) => requestId === input.requestId)
      .at(-1);
    const admission = current.completionFacts.admissions
      .filter(({ requestId }) => requestId === input.requestId)
      .at(-1);
    if (reservation && reservation.requestRoot !== input.requestRoot) {
      throw requestConflict(input.requestId);
    }
    if (reservation && reservation.envelopeDigest !== input.envelopeDigest) {
      throw new CompletionAdmissionError(
        "request_conflict",
        `completion envelope changed for request: ${input.requestId}`,
      );
    }
    if (admission && current.completionTerminalReceipt?.admissionId === admission.id) {
      if (!reservation) throw requestConflict(input.requestId);
      return { state: "admitted", reservation };
    }
    assertNotFailedOrCancelled(current);
    assertNotCompleted(current);
    const correlated = current.completionFacts.requestReservations
      .filter(({ requestRoot }) => requestRoot === input.requestRoot)
      .at(-1);
    if (correlated && correlated.envelopeDigest !== input.envelopeDigest) {
      throw requestConflict(input.requestId);
    }
    if (
      reservation?.ownerId === input.ownerId &&
      reservation.leaseExpiresAt !== undefined &&
      input.now < reservation.leaseExpiresAt
    ) {
      return { state: "existing", reservation };
    }
    if (
      reservation?.ownerId !== undefined &&
      reservation.leaseExpiresAt !== undefined &&
      input.now < reservation.leaseExpiresAt &&
      !input.forceTakeover
    ) {
      return { state: "busy", reservation };
    }
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new CompletionAdmissionError(
        "request_conflict",
        "completion reservation leaseDurationMs must be positive",
      );
    }

    const recordedHead = current.revision + 1;
    const fence = (reservation?.fence ?? 0) + 1;
    const nextReservation = WorkItem.CompletionRequestReservation.parse({
      version: 1,
      id: `completion-reservation:${input.requestId}:${fence}`,
      requestId: input.requestId,
      requestRoot: input.requestRoot,
      attempt: current.attempt,
      basisRef: current.completionContract.basisRef,
      envelopeDigest: input.envelopeDigest,
      expectedHead: current.revision,
      recordedHead,
      createdAt: input.now,
      ownerId: input.ownerId,
      fence,
      leaseExpiresAt: input.now + input.leaseDurationMs,
    });
    assertReservationIdAvailable(current, nextReservation.id);
    const updated = WorkItem.Info.parse({
      ...current,
      revision: recordedHead,
      completionFacts: {
        ...current.completionFacts,
        revision: current.completionFacts.revision + 1,
        requestReservations: [...current.completionFacts.requestReservations, nextReservation],
      },
      timestamps: { ...current.timestamps, updated: input.now },
    });
    if (input.completionWriter(current.hash, current.revision, updated)) {
      return { state: "reserved", reservation: nextReservation };
    }
  }
  throw staleHead(`completion reservation contention did not converge: ${input.requestId}`);
}

function assertReservationIdAvailable(item: WorkItem.Info, reservationId: string): void {
  const collidingFact = [
    ...item.completionFacts.criteria,
    ...item.completionFacts.claims,
    ...item.completionFacts.observations,
    ...item.completionFacts.results,
    ...item.completionFacts.invalidations,
    ...item.completionFacts.verificationErrors,
    ...item.completionFacts.effects,
    ...item.completionFacts.admissions,
  ].find(({ id }) => id === reservationId);
  if (!collidingFact) return;
  throw new CompletionAdmissionError(
    "duplicate_fact_id",
    `completion reservation id collides with completion fact: ${reservationId}`,
  );
}

export function assertCompletionReservationLease(input: CompletionReservationLeaseInput): void {
  const current = requiredItem(
    requiredAdapter(input.workItemHash).get(input.workItemHash),
    input.workItemHash,
  );
  const reservation = current.completionFacts.requestReservations
    .filter(({ requestId }) => requestId === input.requestId)
    .at(-1);
  if (
    reservation?.id !== input.reservationId ||
    reservation.ownerId !== input.ownerId ||
    reservation.fence !== input.fence ||
    reservation.attempt !== current.attempt ||
    reservation.basisRef !== current.completionContract.basisRef ||
    reservation.leaseExpiresAt === undefined ||
    input.now >= reservation.leaseExpiresAt
  ) {
    throw new CompletionAdmissionError(
      "request_conflict",
      `completion reservation lease lost: ${input.requestId}`,
    );
  }
}

function releaseCompletionReservation(
  item: WorkItem.Info,
  reservation: WorkItem.CompletionRequestReservation,
  releasedAt: number,
  completionWriter: Storage.WorkItemCompletionWriter,
  ownerId: string,
): boolean {
  const releasedReservation = WorkItem.CompletionRequestReservation.parse({
    ...reservation,
    id: `${reservation.id}:release:${reservation.fence + 1}`,
    expectedHead: item.revision,
    recordedHead: item.revision + 1,
    createdAt: releasedAt,
    ownerId,
    fence: reservation.fence + 1,
    leaseExpiresAt: releasedAt,
  });
  const candidate = WorkItem.Info.parse({
    ...item,
    revision: item.revision + 1,
    completionFacts: {
      ...item.completionFacts,
      revision: item.completionFacts.revision + 1,
      requestReservations: [...item.completionFacts.requestReservations, releasedReservation],
    },
    timestamps: { ...item.timestamps, updated: Math.max(item.timestamps.updated, releasedAt) },
  });
  return completionWriter(item.hash, item.revision, candidate);
}

type CompletionAuthoritySubject = Readonly<{
  workItemHash: string;
  requestId: string;
  contractRevision: string;
  basisRef: string;
  expectedHead: number;
}>;

export type CompletionStakesResolver = Readonly<{
  resolve(
    subject: CompletionAuthoritySubject,
  ): CompletionStakesInjection | Promise<CompletionStakesInjection>;
}>;

export type CompletionResultAuthorityCandidate = Readonly<{
  workItemHash: string;
  requestId: string;
  contractRevision: string;
  basisRef: string;
  criterion: WorkItem.Criterion;
  result: WorkItem.CriterionResult;
  observations: readonly WorkItem.Observation[];
}>;

type CompletionResultAuthorityValidation = Readonly<{ ok: boolean }>;

export type CompletionResultAuthorityPort = Readonly<{
  validate(
    candidate: CompletionResultAuthorityCandidate,
  ): CompletionResultAuthorityValidation | Promise<CompletionResultAuthorityValidation>;
}>;

export type CompletionVerificationErrorAuthorityCandidate = CompletionAuthoritySubject &
  Readonly<{
    criterion: WorkItem.Criterion;
    error: WorkItem.VerificationErrorFact;
  }>;

export type CompletionVerificationErrorAuthorityPort = Readonly<{
  validate(
    candidate: CompletionVerificationErrorAuthorityCandidate,
  ): CompletionResultAuthorityValidation | Promise<CompletionResultAuthorityValidation>;
}>;

type OwnerOverrideCandidate = Readonly<{
  receiptRef: string;
  workItemHash: string;
  requestId: string;
  contractRevision: string;
  basisRef: string;
  expectedHead: number;
  requestRoot: string;
}>;

type OwnerOverrideValidator = (candidate: OwnerOverrideCandidate) => boolean | Promise<boolean>;

export type CompletionDecision = (
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
) => Promise<WorkItem.CompletionAdmission>;

type CompletionDecisionDependencies = Readonly<{
  policyEngine: ReturnType<typeof PolicyEngine.create>;
  stakesResolver?: CompletionStakesResolver;
  resultAuthorityPort?: CompletionResultAuthorityPort;
  verificationErrorAuthorityPort?: CompletionVerificationErrorAuthorityPort;
  ownerOverrideValidator?: OwnerOverrideValidator;
  now?: () => number;
}>;

type CompletionCandidate = Readonly<{
  effectiveResultIds: readonly string[];
  unresolvedCriterionIds: readonly string[];
  reasonCodes: readonly string[];
  assertedCriterionIds: readonly string[];
  proposedFactIds: readonly string[];
}>;

type CompletionStakesContext = Readonly<{
  ref: string;
  valueMilli: number;
  comparison: "below" | "at" | "above";
}>;

const EMPTY_POLICY: CompletionPolicy = Object.freeze({
  policyRef: "completion.pre-fold",
  verdict: "allow",
  allowedAssertedCriterionIds: [],
  reasonCodes: [],
});

export function createCompletionDecision(
  dependencies: CompletionDecisionDependencies,
): CompletionDecision {
  const now = dependencies.now ?? Date.now;

  return async (item, request) => {
    assertRequestAtHead(item, request);
    assertRequesterFactsSupported(request);
    assertProposedFacts(item, request);
    await assertResultAuthority(dependencies.resultAuthorityPort, item, request);
    const ownerOverride = await resolveOwnerOverride(
      dependencies.ownerOverrideValidator,
      item,
      request,
    );
    assertProposedClaimAuthority(item, request, ownerOverride !== undefined);
    await assertProposedVerificationErrorAuthority(
      dependencies.verificationErrorAuthorityPort,
      item,
      request,
    );

    const foldInput = completionInput(item, request, now());
    const preAdmission = foldWithAuthorityErrors(foldInput);
    const candidate = completionCandidate(item, request, preAdmission);
    const stakes = await resolveStakes(
      dependencies.stakesResolver,
      authoritySubject(request),
      candidate,
    );
    const policyDecision = await dependencies.policyEngine.dispatchPoint("work.complete.pre", {
      workItemHash: request.workItemHash,
      requestId: request.id,
      contractRevision: request.contractRevision,
      basisRef: request.basisRef,
      expectedHead: request.expectedHead,
      completionCandidate: stakes ? { ...candidate, stakes } : candidate,
      unresolvedBlockerIds: item.blockers
        .filter((blocker) => blocker.resolvedAt === undefined)
        .map((blocker) => blocker.id),
      resourceDescriptor: {
        id: `work:${item.hash}`,
        kind: "work",
        labels: [],
        capabilities: [],
        effects: [],
      },
    });
    return foldWithAuthorityErrors({
      ...foldInput,
      policy: completionPolicy(policyDecision),
      ...(stakes ? { stakes: { ref: stakes.ref, comparison: stakes.comparison } } : {}),
      ...(ownerOverride ? { ownerOverride } : {}),
    });
  };
}

function foldWithAuthorityErrors(input: CompletionEvaluationInput): WorkItem.CompletionAdmission {
  try {
    return foldCompletion(input);
  } catch (error) {
    if (error instanceof Error && error.name === "CompletionFoldError") {
      const code =
        Reflect.get(error, "code") === "duplicate_fact_id"
          ? ("duplicate_fact_id" as const)
          : ("unsupported_fact" as const);
      throw new CompletionAdmissionError(code, error.message);
    }
    throw error;
  }
}

function assertRequesterFactsSupported(request: WorkItem.CompletionRequest): void {
  if (request.invalidations.length > 0) {
    throw new CompletionAdmissionError(
      "unsupported_fact",
      "completion requests cannot propose result invalidations without trusted authority",
    );
  }
  if (request.effects.length === 0) return;
  throw new CompletionAdmissionError(
    "unsupported_fact",
    "completion requests cannot propose effects without trusted authority",
  );
}

async function assertProposedVerificationErrorAuthority(
  port: CompletionVerificationErrorAuthorityPort | undefined,
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
): Promise<void> {
  if (request.verificationErrors.length === 0) return;
  if (!port) {
    throw new CompletionAdmissionError(
      "invalid_verifier",
      "proposed verification errors require verifier authority",
    );
  }
  for (const error of request.verificationErrors) {
    const criterion = item.completionFacts.criteria.find(({ id }) => id === error.criterionId);
    if (!criterion) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        `verification error criterion is unknown: ${error.criterionId}`,
      );
    }
    const validation = await port.validate({
      ...authoritySubject(request),
      criterion,
      error,
    });
    if (!validation.ok) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        `verification error authority rejected ${error.id}`,
      );
    }
  }
}

function assertProposedFacts(item: WorkItem.Info, request: WorkItem.CompletionRequest): void {
  const basedFacts: readonly Readonly<{ id: string; basisRef: string }>[] = [
    ...request.claims,
    ...request.observations,
    ...request.results,
    ...request.invalidations,
    ...request.verificationErrors,
  ];
  const staleFact = basedFacts.find((fact) => fact.basisRef !== request.basisRef);
  if (staleFact) {
    throw new CompletionAdmissionError(
      "stale_basis",
      `proposed fact ${staleFact.id} does not match basis ${request.basisRef}`,
    );
  }
  const foreignObservation = request.observations.find(
    (observation) => observation.subjectRef !== item.hash,
  );
  if (foreignObservation) {
    throw new CompletionAdmissionError(
      "invalid_subject",
      `observation ${foreignObservation.id} does not target ${item.hash}`,
    );
  }
  const foreignEffect = request.effects.find((effect) => effect.attempt !== item.attempt);
  if (foreignEffect) {
    throw new CompletionAdmissionError(
      "invalid_subject",
      `effect ${foreignEffect.id} does not target attempt ${item.attempt}`,
    );
  }
}

async function assertResultAuthority(
  port: CompletionResultAuthorityPort | undefined,
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
): Promise<void> {
  const invalidatedResultIds = new Set(
    [...item.completionFacts.invalidations, ...request.invalidations]
      .filter((invalidation) => invalidation.basisRef === request.basisRef)
      .map(({ resultId }) => resultId),
  );
  const mergedObservations = [...item.completionFacts.observations, ...request.observations];
  const entries = [
    ...item.completionFacts.results
      .filter(
        (result) => result.basisRef === request.basisRef && !invalidatedResultIds.has(result.id),
      )
      .map((result) => ({ result, durable: true })),
    ...request.results.map((result) => ({ result, durable: false })),
  ];
  const resolvedObservations = new Map<string, readonly WorkItem.Observation[]>();
  for (const { result, durable } of entries) {
    const scope = durable ? item.completionFacts.observations : mergedObservations;
    const observations = result.observationIds.flatMap((observationId) => {
      const observation = scope.find((candidate) => candidate.id === observationId);
      return observation ? [observation] : [];
    });
    if (
      observations.length !== result.observationIds.length ||
      observations.some(
        (observation) =>
          observation.basisRef !== result.basisRef || observation.subjectRef !== item.hash,
      )
    ) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        `${durable ? "durable" : "proposed"} result ${result.id} has no authoritative observation basis`,
      );
    }
    resolvedObservations.set(result.id, observations);
  }
  for (const { result, durable } of entries) {
    if (result.value === "asserted") continue;
    const criterion = item.completionFacts.criteria.find(
      (candidate) => candidate.id === result.criterionId,
    );
    if (
      criterion === undefined ||
      result.observationIds.length === 0 ||
      result.verifierRef === undefined
    ) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        `${durable ? "durable" : "proposed"} result ${result.id} has no authoritative verifier basis`,
      );
    }
    if (!port) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        durable
          ? `durable result ${result.id} has no configured result authority`
          : "proposed non-asserted results require result authority",
      );
    }
    const validation = await port.validate({
      workItemHash: item.hash,
      requestId: request.id,
      contractRevision: request.contractRevision,
      basisRef: request.basisRef,
      criterion,
      result,
      observations: resolvedObservations.get(result.id) ?? [],
    });
    if (!validation.ok) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        `${durable ? "durable result authority" : "result authority"} rejected ${result.id}`,
      );
    }
  }
}

function assertProposedClaimAuthority(
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  ownerOverrideAuthorized: boolean,
): void {
  const results = [...item.completionFacts.results, ...request.results].filter(
    (result) => result.basisRef === request.basisRef,
  );
  for (const claim of request.claims) {
    const criterion = item.completionFacts.criteria.find(({ id }) => id === claim.criterionId);
    if (!criterion || claim.statement !== criterion.statement) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        `claim ${claim.id} does not match its persisted criterion`,
      );
    }
    const authoritativeObservationIds = new Set(
      ownerOverrideAuthorized
        ? [...item.completionFacts.observations, ...request.observations]
            .filter(
              (observation) =>
                observation.subjectRef === item.hash && observation.basisRef === request.basisRef,
            )
            .map(({ id }) => id)
        : results
            .filter((result) => result.criterionId === claim.criterionId)
            .flatMap((result) => result.observationIds),
    );
    const unboundObservationId = claim.observationIds.find(
      (observationId) => !authoritativeObservationIds.has(observationId),
    );
    if (unboundObservationId) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        `claim ${claim.id} observation ${unboundObservationId} is not bound to a criterion result`,
      );
    }
  }
}

function completionInput(
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  createdAt: number,
): CompletionEvaluationInput {
  return {
    admissionId: admissionId(request),
    requestId: request.id,
    requestRoot: completionRequestRoot(request),
    sourceIdentity: request.sourceIdentity,
    origin: request.origin,
    workItemHash: request.workItemHash,
    contractRevision: request.contractRevision,
    basisRef: request.basisRef,
    expectedHead: request.expectedHead,
    createdAt,
    durableFacts: item.completionFacts,
    proposedFacts: proposedFacts(request),
    blockers: item.blockers,
    currentAttempt: item.attempt,
    policy: EMPTY_POLICY,
  };
}

function completionCandidate(
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  admission: WorkItem.CompletionAdmission,
): CompletionCandidate {
  const effectiveResultIds = new Set(admission.effectiveResultIds);
  const assertedCriterionIds = [...item.completionFacts.results, ...request.results]
    .filter((result) => effectiveResultIds.has(result.id) && result.value === "asserted")
    .map((result) => result.criterionId);
  return Object.freeze({
    effectiveResultIds: admission.effectiveResultIds,
    unresolvedCriterionIds: admission.unresolvedCriterionIds,
    reasonCodes: admission.reasonCodes,
    assertedCriterionIds: [...new Set(assertedCriterionIds)],
    proposedFactIds: [
      ...request.claims,
      ...request.observations,
      ...request.results,
      ...request.invalidations,
      ...request.verificationErrors,
      ...request.effects,
    ].map((fact) => fact.id),
  });
}

function completionPolicy(decision: Policy.PolicyDecision): CompletionPolicy {
  const allowedAssertedCriterionIds = decision.effects.flatMap((effect) =>
    effect.type === "work.allow_asserted" ? effect.criterionIds : [],
  );
  const aborted = decision.effects.some((effect) => effect.type === "run.abort");
  return {
    policyRef: decision.policyId,
    verdict: aborted ? "deny" : decision.verdict,
    allowedAssertedCriterionIds: [...new Set(allowedAssertedCriterionIds)],
    reasonCodes: decision.reasonCodes,
  };
}

async function resolveStakes(
  resolver: CompletionStakesResolver | undefined,
  subject: CompletionAuthoritySubject,
  candidate: CompletionCandidate,
): Promise<CompletionStakesContext | undefined> {
  if (!resolver || candidate.assertedCriterionIds.length === 0) {
    return undefined;
  }
  const injection = await resolver.resolve(subject);
  if (!injection.ok) return undefined;
  if (
    injection.context.surface !== "work.complete.pre" ||
    injection.context.workItemHash !== subject.workItemHash ||
    injection.context.requestId !== subject.requestId
  ) {
    throw new CompletionAdmissionError(
      "invalid_subject",
      `Stakes completion subject does not match ${subject.workItemHash}:${subject.requestId}`,
    );
  }
  if (
    injection.context.contractRevision !== subject.contractRevision ||
    injection.context.basisRef !== subject.basisRef
  ) {
    throw new CompletionAdmissionError(
      "stale_basis",
      `Stakes completion basis does not match ${subject.workItemHash}:${subject.requestId}`,
    );
  }
  if (injection.context.expectedHead !== subject.expectedHead) {
    throw new CompletionAdmissionError(
      "stale_head",
      `Stakes completion head does not match ${subject.expectedHead}`,
    );
  }
  return {
    ref: injection.context.stakes.reference,
    valueMilli: injection.context.stakes.value,
    comparison: injection.context.stakes.comparison,
  };
}

async function resolveOwnerOverride(
  validator: OwnerOverrideValidator | undefined,
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
): Promise<CompletionEvaluationInput["ownerOverride"]> {
  const receiptRef = request.ownerOverrideReceiptRef;
  if (!validator || receiptRef === undefined) return undefined;
  const requestRoot = completionRequestRoot(request);
  const matchingReservations = item.completionFacts.requestReservations.filter(
    (candidate) => candidate.requestId === request.id && candidate.requestRoot === requestRoot,
  );
  const reservation = matchingReservations.find(
    ({ recordedHead }) => recordedHead === request.expectedHead,
  );
  if (!reservation) return undefined;
  const candidate = {
    receiptRef,
    workItemHash: request.workItemHash,
    requestId: request.id,
    contractRevision: request.contractRevision,
    basisRef: request.basisRef,
    expectedHead: reservation.expectedHead,
    requestRoot,
  } as const;
  if (!(await validator(candidate))) return undefined;
  return candidate;
}

function authoritySubject(request: WorkItem.CompletionRequest): CompletionAuthoritySubject {
  return Object.freeze({
    workItemHash: request.workItemHash,
    requestId: request.id,
    contractRevision: request.contractRevision,
    basisRef: request.basisRef,
    expectedHead: request.expectedHead,
  });
}

function proposedFacts(request: WorkItem.CompletionRequest): CompletionProposedFacts {
  return {
    claims: request.claims,
    observations: request.observations,
    results: request.results,
    invalidations: request.invalidations,
    verificationErrors: request.verificationErrors,
    effects: request.effects,
  };
}

function admissionId(request: WorkItem.CompletionRequest): string {
  return `admission:${request.workItemHash}:${request.id}:${request.expectedHead + 1}`;
}

export type CompletionBoundaryOutcome = Readonly<{
  admission: WorkItem.CompletionAdmission;
  workItem: WorkItem.Info;
  completed: boolean;
}>;

export type CompletionRequestCallOptions = Readonly<{
  reservation?: Readonly<{
    requestRoot: string;
    envelopeDigest: string;
    leaseDurationMs?: number;
  }>;
  beforeAdmissionWrite?: () => void;
  verificationErrorAuthorityPort?: CompletionVerificationErrorAuthorityPort;
}>;

type CompletionServiceReservationInput = Readonly<{
  workItemHash: string;
  requestId: string;
  requestRoot: string;
  envelopeDigest: string;
  leaseDurationMs?: number;
  forceTakeover?: boolean;
}>;

type CompletionServiceLeaseInput = Readonly<{
  workItemHash: string;
  requestId: string;
  reservationId: string;
  fence: number;
}>;

export type CompletionAdmissionService = Readonly<{
  requestCompletion(
    request: WorkItem.CompletionRequest,
    completionReport: WorkItem.CompletionReport,
    options?: CompletionRequestCallOptions,
  ): Promise<CompletionBoundaryOutcome>;
  resumeCompletion(
    workItemHash: string,
    admissionId: string,
    completionReport: WorkItem.CompletionReport,
  ): Promise<CompletionBoundaryOutcome>;
  /**
   * Reserves a completion request under the service's internal owner identity
   * so callers can fence side effects (e.g. read-back) without holding the
   * writer capability or the process ownerId themselves ([CORE-IP-3]).
   */
  reserveRequest(input: CompletionServiceReservationInput): CompletionRequestReservationOutcome;
  assertReservationLease(input: CompletionServiceLeaseInput): void;
  /**
   * Whether this service instance is actively preparing the request in this
   * process (#549). A durable reservation row ("existing") only proves some
   * owner reserved it once; this answers whether the work is in flight HERE.
   */
  hasActiveRequest(requestId: string): boolean;
  /**
   * Marks a request as actively prepared by this invocation and returns the
   * release. The release clears the marker only while this invocation still
   * owns it, so a takeover that re-marked the request is never un-marked by
   * the loser's cleanup (#549 — previously a module-level Map).
   */
  trackActiveRequest(requestId: string, invocationToken: string): () => void;
}>;

type CompletionAdmissionServiceOptions = Readonly<{
  completionWriter: Storage.WorkItemCompletionWriter;
  now: () => number;
  ownerId?: string;
  reservation?: CompletionReservationOptions;
  beforeAdmissionWrite?: () => void;
  decision?: CompletionDecision;
  policyEngine?: ReturnType<typeof PolicyEngine.create>;
  resultAuthorityPort?: CompletionResultAuthorityPort;
  verificationErrorAuthorityPort?: CompletionVerificationErrorAuthorityPort;
  stakesResolver?: CompletionStakesResolver;
  ownerOverrideValidator?: OwnerOverrideValidator;
}>;

type CompletionServiceContext = Readonly<{
  completionWriter: Storage.WorkItemCompletionWriter;
  now: () => number;
  decision: CompletionDecision;
  beforeAdmissionWrite?: () => void;
  reservation?: ResolvedCompletionReservation;
}>;

export function createCompletionAdmissionService(
  options: CompletionAdmissionServiceOptions,
): CompletionAdmissionService {
  const serviceOwnerId = options.ownerId ?? `completion-process:${crypto.randomUUID()}`;
  const reservationOwnerId = options.reservation?.ownerId ?? serviceOwnerId;
  // In-process in-flight tracking is instance state (#549): two services in
  // one process never see each other's active completion requests.
  const activeCompletionRequests = new Map<string, string>();
  const baseDecision =
    options.decision ??
    createCompletionDecision(decisionDependencies(options, options.verificationErrorAuthorityPort));
  const contextFor = (perCall?: CompletionRequestCallOptions): CompletionServiceContext => ({
    completionWriter: options.completionWriter,
    now: options.now,
    decision:
      options.decision === undefined && perCall?.verificationErrorAuthorityPort !== undefined
        ? createCompletionDecision(
            decisionDependencies(options, perCall.verificationErrorAuthorityPort),
          )
        : baseDecision,
    beforeAdmissionWrite: perCall?.beforeAdmissionWrite ?? options.beforeAdmissionWrite,
    reservation: resolveReservation(options.reservation, serviceOwnerId, perCall?.reservation),
  });
  return Object.freeze({
    async requestCompletion(requestInput, completionReportInput, perCall) {
      const ctx = contextFor(perCall);
      let request = WorkItem.CompletionRequest.parse(requestInput);
      assertRequesterFactsSupported(request);
      const completionReport = WorkItem.canonicalCompletionReport(
        WorkItem.CompletionReport.parse(completionReportInput),
      );
      const adapter = authorizedCompletionAdapter(
        requiredAdapter(request.workItemHash),
        ctx.completionWriter,
      );
      let requestedPublished = false;
      for (let attempt = 0; attempt < CompletionCasRetryLimit; attempt += 1) {
        try {
          const initial = requiredItem(adapter.get(request.workItemHash), request.workItemHash);
          assertNotFailedOrCancelled(initial);
          const priorAdmissions = initial.completionFacts.admissions.filter(
            ({ requestId }) => requestId === request.id,
          );
          if (priorAdmissions.length > 0) {
            if (WorkItem.deriveStatus(initial) === "completed") {
              return await replayRequest(initial, request, completionReport, priorAdmissions, ctx);
            }
            const assertReservation =
              ctx.reservation === undefined
                ? undefined
                : reserveCompletionLease(
                    initial,
                    requestIdentityFor(request, completionReport, ctx.reservation),
                    ctx.reservation,
                    ctx,
                  );
            return await replayRequest(
              initial,
              request,
              completionReport,
              priorAdmissions,
              ctx,
              assertReservation,
            );
          }
          assertNotCompleted(initial);
          assertRequestAtHead(initial, request);
          const assertReservation =
            ctx.reservation === undefined
              ? undefined
              : reserveCompletionLease(
                  initial,
                  requestIdentityFor(request, completionReport, ctx.reservation),
                  ctx.reservation,
                  ctx,
                );
          if (assertReservation) {
            const reserved = requiredItem(adapter.get(request.workItemHash), request.workItemHash);
            if (reserved.revision !== initial.revision) {
              if (
                assertReservation.state === "reserved" &&
                assertReservation.recordedHead === reserved.revision &&
                reserved.revision === initial.revision + 1
              ) {
                request = WorkItem.CompletionRequest.parse({
                  ...request,
                  expectedHead: reserved.revision,
                });
                continue;
              }
              throw staleHead(
                `WorkItem changed while reserving completion authority: ${reserved.hash}`,
              );
            }
          }
          if (!requestedPublished) {
            publishRequested(request, initial.sessionId, ctx.now());
            requestedPublished = true;
          }

          assertReservation?.();
          const authorityAdmission = await resolveAuthority(ctx, initial, request);
          const admission = canonicalAdmission(authorityAdmission, completionReport);
          assertUnchangedAfterAuthority(adapter, initial);
          assertAppendableAdmission(admission, initial, request);
          assertReservation?.();
          ctx.beforeAdmissionWrite?.();
          assertUnchangedAfterAuthority(adapter, initial);
          const recorded = await appendAdmission(adapter, initial, request, admission);
          if (!isAdmitted(admission)) {
            return { admission, workItem: recorded, completed: false };
          }

          return await completeOrReevaluate(
            adapter,
            recorded,
            request,
            completionReport,
            admission,
            ctx,
            assertReservation,
          );
        } catch (error) {
          if (!(error instanceof CompletionAdmissionError) || error.code !== "stale_head") {
            throw error;
          }
          const latest = requiredItem(adapter.get(request.workItemHash), request.workItemHash);
          if (
            latest.completionContract.revision !== request.contractRevision ||
            latest.completionContract.basisRef !== request.basisRef
          ) {
            throw new CompletionAdmissionError(
              "stale_basis",
              `completion request basis is stale for ${latest.hash}`,
            );
          }
          request = rebaseRequestAtHead(request, latest.revision, { dropFacts: false });
        }
      }
      throw staleHead(`completion admission contention did not converge: ${request.id}`);
    },

    async resumeCompletion(workItemHash, admissionId, completionReportInput) {
      const ctx = contextFor();
      const completionReport = WorkItem.canonicalCompletionReport(
        WorkItem.CompletionReport.parse(completionReportInput),
      );
      const adapter = authorizedCompletionAdapter(
        requiredAdapter(workItemHash),
        ctx.completionWriter,
      );
      for (let attempt = 0; attempt < CompletionCasRetryLimit; attempt += 1) {
        try {
          return await resumeCompletionAtHead(
            adapter,
            workItemHash,
            admissionId,
            completionReport,
            ctx,
          );
        } catch (error) {
          if (!(error instanceof CompletionAdmissionError) || error.code !== "stale_head") {
            throw error;
          }
        }
      }
      throw staleHead(
        `completion recovery contention did not converge: ${workItemHash}:${admissionId}`,
      );
    },

    reserveRequest(input) {
      return reserveCompletionRequest({
        completionWriter: options.completionWriter,
        workItemHash: input.workItemHash,
        requestId: input.requestId,
        requestRoot: input.requestRoot,
        envelopeDigest: input.envelopeDigest,
        ownerId: reservationOwnerId,
        leaseDurationMs:
          input.leaseDurationMs ??
          options.reservation?.leaseDurationMs ??
          DefaultCompletionLeaseDurationMs,
        now: options.now(),
        ...(input.forceTakeover === undefined ? {} : { forceTakeover: input.forceTakeover }),
      });
    },

    assertReservationLease(input) {
      assertCompletionReservationLease({
        workItemHash: input.workItemHash,
        requestId: input.requestId,
        reservationId: input.reservationId,
        ownerId: reservationOwnerId,
        fence: input.fence,
        now: options.now(),
      });
    },

    hasActiveRequest(requestId) {
      return activeCompletionRequests.has(requestId);
    },

    trackActiveRequest(requestId, invocationToken) {
      activeCompletionRequests.set(requestId, invocationToken);
      return () => {
        if (activeCompletionRequests.get(requestId) === invocationToken) {
          activeCompletionRequests.delete(requestId);
        }
      };
    },
  });
}

function decisionDependencies(
  options: CompletionAdmissionServiceOptions,
  verificationErrorAuthorityPort: CompletionVerificationErrorAuthorityPort | undefined,
): CompletionDecisionDependencies {
  const policyEngine = options.policyEngine;
  if (!policyEngine) {
    throw new Error("completion admission service requires a policyEngine or an injected decision");
  }
  return {
    policyEngine,
    resultAuthorityPort:
      options.resultAuthorityPort ?? createDurableCompletionResultAuthorityPort(),
    verificationErrorAuthorityPort,
    stakesResolver: options.stakesResolver,
    ownerOverrideValidator: options.ownerOverrideValidator,
    now: options.now,
  };
}

function resolveReservation(
  base: CompletionReservationOptions | undefined,
  serviceOwnerId: string,
  perCall: CompletionRequestCallOptions["reservation"],
): ResolvedCompletionReservation | undefined {
  if (base === undefined && perCall === undefined) return undefined;
  return {
    ownerId: base?.ownerId ?? serviceOwnerId,
    leaseDurationMs:
      perCall?.leaseDurationMs ?? base?.leaseDurationMs ?? DefaultCompletionLeaseDurationMs,
    requestRoot: perCall?.requestRoot ?? base?.requestRoot,
    envelopeDigest: perCall?.envelopeDigest ?? base?.envelopeDigest,
  };
}

function requestIdentityFor(
  request: WorkItem.CompletionRequest,
  completionReport: WorkItem.CompletionReport,
  reservation: ResolvedCompletionReservation,
): CompletionRequestIdentity {
  const requestRoot = reservation.requestRoot ?? completionRequestRoot(request);
  return {
    id: request.id,
    requestRoot,
    envelopeDigest:
      reservation.envelopeDigest ??
      completionRequestEnvelopeDigest(
        requestRoot,
        WorkItem.completionReportReference(completionReport),
      ),
  };
}

function reserveCompletionLease(
  item: WorkItem.Info,
  identity: CompletionRequestIdentity,
  reservation: ResolvedCompletionReservation,
  ctx: CompletionServiceContext,
  forceTakeover = false,
): CompletionReservationAssertion {
  const acquired = reserveCompletionRequestWithLimit(
    {
      completionWriter: ctx.completionWriter,
      workItemHash: item.hash,
      requestId: identity.id,
      requestRoot: identity.requestRoot,
      envelopeDigest: identity.envelopeDigest,
      ownerId: reservation.ownerId,
      leaseDurationMs: reservation.leaseDurationMs,
      now: ctx.now(),
      forceTakeover,
    },
    1,
  );
  if (acquired.state === "busy") {
    throw new CompletionAdmissionError(
      "request_conflict",
      `completion request is already in progress: ${identity.id}`,
    );
  }
  if (acquired.state === "admitted") throw requestConflict(identity.id);
  const assertReservation = () =>
    assertCompletionReservationLease({
      workItemHash: item.hash,
      requestId: identity.id,
      reservationId: acquired.reservation.id,
      ownerId: reservation.ownerId,
      fence: acquired.reservation.fence,
      now: ctx.now(),
    });
  return Object.assign(assertReservation, {
    state: acquired.state,
    recordedHead: acquired.reservation.recordedHead,
  });
}

function assertLiveReservation(
  assertion: (() => void) | undefined,
  requestId: string,
): asserts assertion is () => void {
  if (!assertion) {
    throw new CompletionAdmissionError(
      "request_conflict",
      `completion reservation is required: ${requestId}`,
    );
  }
  assertion();
}

async function resumeCompletionAtHead(
  adapter: WorkItemAdapter,
  workItemHash: string,
  admissionId: string,
  completionReport: WorkItem.CompletionReport,
  ctx: CompletionServiceContext,
): Promise<CompletionBoundaryOutcome> {
  const item = requiredItem(adapter.get(workItemHash), workItemHash);
  assertNotFailedOrCancelled(item);
  const admission = item.completionFacts.admissions.find(({ id }) => id === admissionId);
  if (!admission) throw admissionRequired(workItemHash, admissionId);
  assertAdmissionReportMatches(admission, completionReport);
  if (WorkItem.deriveStatus(item) === "completed") {
    if (item.completionTerminalReceipt?.admissionId === admissionId) {
      return { admission, workItem: item, completed: true };
    }
    throw admissionRequired(workItemHash, admissionId);
  }
  assertSameBasis(item, admission);
  const request = requestFromAdmission(item, admission);
  const durableReservation = item.completionFacts.requestReservations.find(
    ({ requestId }) => requestId === admission.requestId,
  );
  const assertReservation =
    ctx.reservation === undefined
      ? undefined
      : reserveCompletionLease(
          item,
          {
            id: admission.requestId,
            requestRoot:
              durableReservation?.requestRoot ??
              ctx.reservation.requestRoot ??
              admission.requestRoot,
            envelopeDigest:
              durableReservation?.envelopeDigest ??
              ctx.reservation.envelopeDigest ??
              completionRequestEnvelopeDigest(
                admission.requestRoot,
                requiredCompletionReportRef(admission),
              ),
          },
          ctx.reservation,
          ctx,
          true,
        );
  assertReservation?.();
  if (isAdmitted(admission) && assertReservation) {
    const reservedItem = requiredItem(adapter.get(workItemHash), workItemHash);
    if (
      reservedItem.revision === assertReservation.recordedHead &&
      WorkItem.hasContiguousReservationBridge(
        reservedItem.completionFacts.requestReservations,
        admission.requestId,
        admission.recordedHead,
        reservedItem.revision + 1,
      )
    ) {
      const completed = commitTerminal(
        adapter,
        reservedItem,
        admission,
        completionReport,
        ctx.now(),
        assertReservation,
        true,
      );
      return { admission, workItem: completed, completed: true };
    }
  }
  if (item.revision === admission.recordedHead) {
    if (!isAdmitted(admission)) return { admission, workItem: item, completed: false };
    const completed = commitTerminal(
      adapter,
      item,
      admission,
      completionReport,
      ctx.now(),
      assertReservation,
    );
    return { admission, workItem: completed, completed: true };
  }

  const nextAdmission = canonicalAdmission(
    await resolveAuthority(ctx, item, request),
    completionReport,
  );
  assertAppendableAdmission(nextAdmission, item, request);
  assertReservation?.();
  ctx.beforeAdmissionWrite?.();
  assertUnchangedAfterAuthority(adapter, item);
  const recorded = await appendAdmission(adapter, item, request, nextAdmission);
  if (!isAdmitted(nextAdmission)) {
    return { admission: nextAdmission, workItem: recorded, completed: false };
  }
  const completed = commitTerminal(
    adapter,
    recorded,
    nextAdmission,
    completionReport,
    ctx.now(),
    assertReservation,
  );
  return { admission: nextAdmission, workItem: completed, completed: true };
}

async function replayRequest(
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  completionReport: WorkItem.CompletionReport,
  admissions: readonly WorkItem.CompletionAdmission[],
  ctx: CompletionServiceContext,
  assertReservation?: CompletionReservationAssertion,
): Promise<CompletionBoundaryOutcome> {
  assertReplayMatches(request, admissions);
  const original = admissions[0];
  if (!original) throw requestConflict(request.id);
  assertAdmissionReportMatches(original, completionReport);
  const receipt = item.completionTerminalReceipt;
  if (WorkItem.deriveStatus(item) === "completed") {
    if (
      item.completionReport === undefined ||
      !completionReportsMatch(item.completionReport, completionReport)
    ) {
      throw requestConflict(request.id);
    }
    const admission = admissions.find(({ id }) => id === receipt?.admissionId);
    if (!admission) throw admissionRequired(item.hash, receipt?.admissionId ?? "missing");
    return { admission, workItem: item, completed: true };
  }
  const admission = admissions.at(-1);
  if (!admission) throw requestConflict(request.id);
  if (ctx.reservation !== undefined) {
    assertLiveReservation(assertReservation, request.id);
  }
  if (!isAdmitted(admission)) {
    if (item.revision === admission.recordedHead) {
      return { admission, workItem: item, completed: false };
    }
    const blockerDescription = completionBlockerDescription(admission);
    if (
      blockerDescription !== undefined &&
      item.revision === admission.recordedHead + 1 &&
      item.blockers.some(
        (blocker) => blocker.resolvedAt === undefined && blocker.description === blockerDescription,
      )
    ) {
      return { admission, workItem: item, completed: false };
    }
    return completeOrReevaluate(
      authorizedCompletionAdapter(requiredAdapter(item.hash), ctx.completionWriter),
      item,
      request,
      completionReport,
      admission,
      ctx,
      assertReservation,
    );
  }
  if (item.revision === admission.recordedHead) {
    const completed = commitTerminal(
      authorizedCompletionAdapter(requiredAdapter(item.hash), ctx.completionWriter),
      item,
      admission,
      completionReport,
      ctx.now(),
      assertReservation,
    );
    return { admission, workItem: completed, completed: true };
  }
  if (
    assertReservation?.recordedHead === item.revision &&
    WorkItem.hasContiguousReservationBridge(
      item.completionFacts.requestReservations,
      admission.requestId,
      admission.recordedHead,
      item.revision + 1,
    )
  ) {
    const completed = commitTerminal(
      authorizedCompletionAdapter(requiredAdapter(item.hash), ctx.completionWriter),
      item,
      admission,
      completionReport,
      ctx.now(),
      assertReservation,
      true,
    );
    return { admission, workItem: completed, completed: true };
  }
  return completeOrReevaluate(
    authorizedCompletionAdapter(requiredAdapter(item.hash), ctx.completionWriter),
    item,
    request,
    completionReport,
    admission,
    ctx,
    assertReservation,
  );
}

async function completeOrReevaluate(
  adapter: WorkItemAdapter,
  recorded: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  completionReport: WorkItem.CompletionReport,
  admission: WorkItem.CompletionAdmission,
  ctx: CompletionServiceContext,
  assertReservation: (() => void) | undefined,
): Promise<CompletionBoundaryOutcome> {
  assertReservation?.();
  const latest = requiredItem(adapter.get(recorded.hash), recorded.hash);
  assertNotFailedOrCancelled(latest);
  if (WorkItem.deriveStatus(latest) === "completed") {
    if (
      latest.completionTerminalReceipt?.requestId !== request.id ||
      latest.completionReport === undefined ||
      !completionReportsMatch(latest.completionReport, completionReport)
    ) {
      throw requestConflict(request.id);
    }
    const terminalAdmission = latest.completionFacts.admissions.find(
      ({ id }) => id === latest.completionTerminalReceipt?.admissionId,
    );
    if (!terminalAdmission) {
      throw admissionRequired(latest.hash, latest.completionTerminalReceipt.admissionId);
    }
    return { admission: terminalAdmission, workItem: latest, completed: true };
  }
  if (latest.revision === admission.recordedHead) {
    const completed = commitTerminal(
      adapter,
      latest,
      admission,
      completionReport,
      ctx.now(),
      assertReservation,
    );
    return { admission, workItem: completed, completed: true };
  }
  assertSameBasis(latest, admission);

  const recheck = rebaseRequestAtHead(request, latest.revision, { dropFacts: true });
  const nextAdmission = canonicalAdmission(
    await resolveAuthority(ctx, latest, recheck),
    completionReport,
  );
  assertAppendableAdmission(nextAdmission, latest, recheck);
  assertReservation?.();
  ctx.beforeAdmissionWrite?.();
  assertUnchangedAfterAuthority(adapter, latest);
  const nextRecorded = await appendAdmission(adapter, latest, recheck, nextAdmission);
  if (!isAdmitted(nextAdmission)) {
    return { admission: nextAdmission, workItem: nextRecorded, completed: false };
  }
  const beforeTerminal = requiredItem(adapter.get(latest.hash), latest.hash);
  if (beforeTerminal.revision !== nextAdmission.recordedHead) {
    throw staleHead(`WorkItem changed again while completing: ${latest.hash}`);
  }
  const completed = commitTerminal(
    adapter,
    beforeTerminal,
    nextAdmission,
    completionReport,
    ctx.now(),
    assertReservation,
  );
  return { admission: nextAdmission, workItem: completed, completed: true };
}

async function appendAdmission(
  adapter: WorkItemAdapter,
  existing: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  admission: WorkItem.CompletionAdmission,
): Promise<WorkItem.Info> {
  const proposed = canonicalCompletionRequest(request);
  const knownFactIds = new Set(
    [
      ...existing.completionFacts.criteria,
      ...existing.completionFacts.claims,
      ...existing.completionFacts.observations,
      ...existing.completionFacts.results,
      ...existing.completionFacts.invalidations,
      ...existing.completionFacts.verificationErrors,
      ...existing.completionFacts.effects,
      ...existing.completionFacts.admissions,
      ...existing.completionFacts.requestReservations,
      ...proposed.claims,
      ...proposed.observations,
      ...proposed.results,
      ...proposed.invalidations,
      ...proposed.verificationErrors,
      ...proposed.effects,
    ].map(({ id }) => id),
  );
  if (knownFactIds.has(admission.id)) throw requestConflict(request.id);
  const updated = WorkItem.Info.parse({
    ...existing,
    revision: admission.recordedHead,
    completionFacts: {
      ...existing.completionFacts,
      revision: existing.completionFacts.revision + 1,
      claims: appendFacts(existing.completionFacts.claims, proposed.claims, WorkItem.Claim),
      observations: appendFacts(
        existing.completionFacts.observations,
        proposed.observations,
        WorkItem.Observation,
      ),
      results: appendFacts(
        existing.completionFacts.results,
        proposed.results,
        WorkItem.CriterionResult,
      ),
      invalidations: appendFacts(
        existing.completionFacts.invalidations,
        proposed.invalidations,
        WorkItem.ResultInvalidation,
      ),
      verificationErrors: appendFacts(
        existing.completionFacts.verificationErrors,
        proposed.verificationErrors,
        WorkItem.VerificationErrorFact,
      ),
      effects: appendFacts(
        existing.completionFacts.effects,
        proposed.effects,
        WorkItem.EffectRecord,
      ),
      admissions: [...existing.completionFacts.admissions, admission],
    },
    timestamps: { ...existing.timestamps, updated: admission.createdAt },
  });
  if (!adapter.compareAndSet(existing.hash, existing.revision, updated)) {
    throw staleHead(`WorkItem changed while recording completion admission: ${existing.hash}`);
  }
  Bus.publish(WorkItem.Events.CompletionAdmissionRecorded, {
    traceId: crypto.randomUUID(),
    time: admission.createdAt,
    sessionId: updated.sessionId,
    payload: {
      hash: updated.hash,
      admissionId: admission.id,
      decision: admission.decision,
      recordedHead: admission.recordedHead,
    },
  });
  return updated;
}

function commitTerminal(
  adapter: WorkItemAdapter,
  existing: WorkItem.Info,
  admission: WorkItem.CompletionAdmission,
  completionReport: WorkItem.CompletionReport,
  time: number,
  assertReservation: (() => void) | undefined,
  reservationBridged = false,
): WorkItem.Info {
  const current = requiredItem(adapter.get(existing.hash), existing.hash);
  assertNotFailedOrCancelled(current);
  if (
    current.revision !== existing.revision ||
    (!reservationBridged && current.revision !== admission.recordedHead)
  ) {
    throw staleHead(`WorkItem changed before terminal completion: ${existing.hash}`);
  }
  assertSameBasis(current, admission);
  const report = verifyCompletionReport(current, admission, completionReport);
  const receipt: WorkItem.CompletionTerminalReceipt = {
    version: 1,
    hash: current.hash,
    requestId: admission.requestId,
    admissionId: admission.id,
    contractRevision: admission.contractRevision,
    basisRef: admission.basisRef,
    completionReportRef: requiredCompletionReportRef(admission),
    recordedHead: existing.revision + 1,
  };
  const completed = WorkItem.Info.parse({
    ...current,
    revision: current.revision + 1,
    completionReport: report,
    completionTerminalReceipt: receipt,
    timestamps: { ...current.timestamps, completed: time, updated: time },
  });
  assertReservation?.();
  if (!adapter.compareAndSet(current.hash, current.revision, completed)) {
    throw staleHead(`WorkItem changed during terminal completion: ${current.hash}`);
  }
  const previousStatus = WorkItem.deriveStatus(current);
  const completedStatus = WorkItem.deriveStatus(completed);
  if (previousStatus !== completedStatus) {
    Bus.publish(WorkItem.Events.StatusChanged, {
      traceId: crypto.randomUUID(),
      time,
      sessionId: completed.sessionId,
      payload: { hash: completed.hash, from: previousStatus, to: completedStatus },
    });
  }
  Bus.publish(WorkItem.Events.Updated, {
    traceId: crypto.randomUUID(),
    time,
    sessionId: completed.sessionId,
    payload: {
      hash: completed.hash,
      fields: ["timestamps", "completionReport", "completionTerminalReceipt"],
    },
  });
  Bus.publish(WorkItem.Events.CompletedV2, {
    traceId: crypto.randomUUID(),
    time,
    sessionId: completed.sessionId,
    payload: { ...receipt, sessionId: completed.sessionId },
  });
  return completed;
}

function assertRequestAtHead(item: WorkItem.Info, request: WorkItem.CompletionRequest): void {
  if (request.workItemHash !== item.hash) {
    throw new CompletionAdmissionError(
      "invalid_subject",
      `completion request subject ${request.workItemHash} does not match ${item.hash}`,
    );
  }
  if (request.expectedHead !== item.revision) {
    throw staleHead(
      `completion request head ${request.expectedHead} does not match ${item.revision}`,
    );
  }
  if (
    request.contractRevision !== item.completionContract.revision ||
    request.basisRef !== item.completionContract.basisRef
  ) {
    throw new CompletionAdmissionError(
      "stale_basis",
      `completion request basis is stale for ${item.hash}`,
    );
  }
}

/** Exact denormalized-identity match: both absent, or field-for-field equal. */
function sameSourceIdentity(
  left: WorkItem.CompletionSourceIdentity | undefined,
  right: WorkItem.CompletionSourceIdentity | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.source === right.source &&
    left.identity.kind === right.identity.kind &&
    left.identity.id === right.identity.id
  );
}

// Documented residual: a forged admit that omits a required criterion while
// reporting empty unresolvedCriterionIds is rejected at commitTerminal's
// Info.parse (post-append terminal linkage) instead of pre-append here.
function assertAppendableAdmission(
  admission: WorkItem.CompletionAdmission,
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
): void {
  if (
    admission.requestId !== request.id ||
    admission.workItemHash !== item.hash ||
    admission.requestRoot !== completionRequestRoot(request) ||
    admission.origin !== request.origin ||
    !sameSourceIdentity(admission.sourceIdentity, request.sourceIdentity) ||
    admission.contractRevision !== item.completionContract.revision ||
    admission.basisRef !== item.completionContract.basisRef
  ) {
    throw requestConflict(request.id);
  }
  if (admission.expectedHead !== item.revision || admission.recordedHead !== item.revision + 1) {
    throw staleHead(`completion admission head does not match ${item.revision}`);
  }
  const resultsById = new Map(
    [...item.completionFacts.results, ...request.results].map((result) => [result.id, result]),
  );
  if (
    admission.effectiveResultIds.some((resultId) => {
      const result = resultsById.get(resultId);
      return !result || result.basisRef !== request.basisRef;
    })
  ) {
    throw requestConflict(request.id);
  }
  const criterionIds = new Set(item.completionFacts.criteria.map(({ id }) => id));
  if (admission.unresolvedCriterionIds.some((criterionId) => !criterionIds.has(criterionId))) {
    throw requestConflict(request.id);
  }
  if (admission.decision === "admit") {
    const effectiveResults = admission.effectiveResultIds.map((resultId) =>
      resultsById.get(resultId),
    );
    if (
      effectiveResults.some(
        (result) =>
          !result ||
          result.basisRef !== admission.basisRef ||
          result.value === "refuted" ||
          result.value === "inconclusive",
      )
    ) {
      throw requestConflict(request.id);
    }
  }
}

function assertReplayMatches(
  request: WorkItem.CompletionRequest,
  admissions: readonly WorkItem.CompletionAdmission[],
): void {
  const original = admissions[0];
  if (
    !original ||
    original.origin !== request.origin ||
    original.contractRevision !== request.contractRevision ||
    original.basisRef !== request.basisRef ||
    original.requestRoot !== completionRequestRoot(request)
  ) {
    throw requestConflict(request.id);
  }
}

function appendFacts<T extends { id: string }>(
  current: readonly T[],
  additions: readonly unknown[],
  schema: { parse(value: unknown): T },
): T[] {
  const next = [...current];
  const ids = new Set(current.map(({ id }) => id));
  for (const addition of additions) {
    const parsed = schema.parse(addition);
    if (ids.has(parsed.id)) throw requestConflict(parsed.id);
    ids.add(parsed.id);
    next.push(parsed);
  }
  return next;
}

function verifyCompletionReport(
  item: WorkItem.Info,
  admission: WorkItem.CompletionAdmission,
  report: WorkItem.CompletionReport,
): WorkItem.CompletionReport {
  const evidenceById = new Map(item.evidence.map((evidence) => [evidence.id, evidence]));
  const missing = report.claims.flatMap((claim) =>
    claim.evidenceIds.filter((evidenceId) => !evidenceById.has(evidenceId)),
  );
  if (missing.length > 0) {
    throw new Error(`completion report references missing evidence: ${missing.join(", ")}`);
  }
  const outOfScope = report.claims.flatMap((claim) =>
    claim.evidenceIds.filter((evidenceId) => {
      const evidence = evidenceById.get(evidenceId);
      return evidence?.attempt !== item.attempt || evidence.basisRef !== admission.basisRef;
    }),
  );
  if (outOfScope.length > 0) {
    throw new Error(
      `completion report references evidence from a different attempt: ${outOfScope.join(", ")}`,
    );
  }
  const failed = report.claims.flatMap((claim) =>
    claim.evidenceIds.filter((evidenceId) => {
      const evidence = evidenceById.get(evidenceId);
      return evidence?.passed === false || evidence?.readBack?.passed === false;
    }),
  );
  if (failed.length > 0) {
    throw new Error(`completion report references failed evidence: ${failed.join(", ")}`);
  }
  const effectiveResults = item.completionFacts.results.filter((result) =>
    admission.effectiveResultIds.includes(result.id),
  );
  const effectiveCriterionIds = new Set(effectiveResults.map(({ criterionId }) => criterionId));
  const observationsById = new Map(
    item.completionFacts.observations.map((observation) => [observation.id, observation]),
  );
  for (const reportClaim of report.claims) {
    const admittedClaims = item.completionFacts.claims.filter(
      (claim) =>
        claim.statement === reportClaim.statement &&
        claim.basisRef === admission.basisRef &&
        (admission.decision === "owner_override" || effectiveCriterionIds.has(claim.criterionId)),
    );
    if (admittedClaims.length === 0) {
      throw new Error(`completion report claim is not admitted: ${reportClaim.statement}`);
    }
    const criterionIds = new Set(admittedClaims.map(({ criterionId }) => criterionId));
    const effectiveObservationIds = new Set(
      effectiveResults
        .filter(({ criterionId }) => criterionIds.has(criterionId))
        .flatMap(({ observationIds: ids }) => ids),
    );
    const observationIds = new Set(
      admittedClaims.flatMap(({ observationIds: ids }) =>
        ids.filter(
          (observationId) =>
            admission.decision === "owner_override" || effectiveObservationIds.has(observationId),
        ),
      ),
    );
    const admittedEvidenceIds = new Set(
      [...observationIds].flatMap((observationId) => {
        const observation = observationsById.get(observationId);
        if (!observation) return [];
        return [
          ...observation.artifactRefs,
          ...(observation.provenanceRef === undefined ? [] : [observation.provenanceRef]),
        ];
      }),
    );
    const unrelatedEvidence = reportClaim.evidenceIds.filter(
      (evidenceId) => !admittedEvidenceIds.has(evidenceId),
    );
    if (unrelatedEvidence.length > 0) {
      throw new Error(
        `completion report evidence is not admitted: ${unrelatedEvidence.join(", ")}`,
      );
    }
  }
  return report;
}

function publishRequested(
  request: WorkItem.CompletionRequest,
  sessionId: string | undefined,
  time: number,
): void {
  Bus.publish(WorkItem.Events.CompletionRequested, {
    traceId: crypto.randomUUID(),
    time,
    sessionId,
    payload: request,
  });
}

function rebaseRequestAtHead(
  request: WorkItem.CompletionRequest,
  expectedHead: number,
  options: Readonly<{ dropFacts: boolean }>,
): WorkItem.CompletionRequest {
  const { ownerOverrideReceiptRef: _staleOwnerReceipt, ...unboundRequest } = request;
  return WorkItem.CompletionRequest.parse({
    ...unboundRequest,
    expectedHead,
    ...(options.dropFacts
      ? {
          claims: [],
          observations: [],
          results: [],
          invalidations: [],
          verificationErrors: [],
          effects: [],
        }
      : {}),
  });
}

async function resolveAuthority(
  ctx: CompletionServiceContext,
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
): Promise<WorkItem.CompletionAdmission> {
  try {
    return await ctx.decision(item, request);
  } catch (error) {
    if (error instanceof CompletionAdmissionError) {
      throw error;
    }
    throw new CompletionAdmissionError(
      "authority_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function requestFromAdmission(
  item: WorkItem.Info,
  admission: WorkItem.CompletionAdmission,
): WorkItem.CompletionRequest {
  return WorkItem.CompletionRequest.parse({
    version: 1,
    id: admission.requestId,
    origin: admission.origin,
    sourceIdentity: admission.sourceIdentity,
    workItemHash: item.hash,
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    expectedHead: item.revision,
    claims: [],
    observations: [],
    results: [],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  });
}

function assertUnchangedAfterAuthority(adapter: WorkItemAdapter, expected: WorkItem.Info): void {
  const current = requiredItem(adapter.get(expected.hash), expected.hash);
  assertNotFailedOrCancelled(current);
  if (current.revision !== expected.revision) {
    throw staleHead(`WorkItem changed while resolving completion authority: ${expected.hash}`);
  }
}

function assertNotFailedOrCancelled(item: WorkItem.Info): void {
  const status = WorkItem.deriveStatus(item);
  if (status !== "failed" && status !== "cancelled") return;
  throw new CompletionAdmissionError(
    "terminal_state",
    `Cannot complete a ${status} WorkItem: ${item.hash}`,
  );
}

function assertNotCompleted(item: WorkItem.Info): void {
  if (WorkItem.deriveStatus(item) !== "completed") return;
  throw new CompletionAdmissionError(
    "terminal_state",
    `Cannot start a new completion request for completed WorkItem: ${item.hash}`,
  );
}

function assertSameBasis(item: WorkItem.Info, admission: WorkItem.CompletionAdmission): void {
  if (
    admission.contractRevision !== item.completionContract.revision ||
    admission.basisRef !== item.completionContract.basisRef
  ) {
    throw new CompletionAdmissionError(
      "stale_basis",
      `completion admission basis is stale for ${item.hash}`,
    );
  }
}

function canonicalAdmission(
  input: WorkItem.CompletionAdmission,
  completionReport: WorkItem.CompletionReport,
): WorkItem.CompletionAdmission {
  const admission = WorkItem.CompletionAdmission.parse(input);
  const completionReportSnapshot = WorkItem.canonicalCompletionReport(completionReport);
  const completionReportRef = WorkItem.completionReportReference(completionReportSnapshot);
  if (
    (admission.completionReportSnapshot !== undefined &&
      !completionReportsMatch(admission.completionReportSnapshot, completionReportSnapshot)) ||
    (admission.completionReportRef !== undefined &&
      admission.completionReportRef !== completionReportRef)
  ) {
    throw requestConflict(admission.requestId);
  }
  return WorkItem.CompletionAdmission.parse({
    ...admission,
    completionReportSnapshot,
    completionReportRef,
  });
}

function assertAdmissionReportMatches(
  admission: WorkItem.CompletionAdmission,
  completionReport: WorkItem.CompletionReport,
): void {
  const snapshot = admission.completionReportSnapshot;
  const reference = admission.completionReportRef;
  if (
    snapshot === undefined ||
    reference === undefined ||
    reference !== WorkItem.completionReportReference(snapshot) ||
    !completionReportsMatch(snapshot, completionReport)
  ) {
    throw requestConflict(admission.requestId);
  }
}

function requiredCompletionReportRef(admission: WorkItem.CompletionAdmission): string {
  const reference = admission.completionReportRef;
  if (reference === undefined) throw requestConflict(admission.requestId);
  return reference;
}

function isAdmitted(admission: WorkItem.CompletionAdmission): boolean {
  return admission.decision === "admit" || admission.decision === "owner_override";
}

function requiredAdapter(hash: string): WorkItemAdapter {
  const adapter = Storage.get().workItem;
  if (!adapter) {
    throw new CompletionAdmissionError(
      "invalid_subject",
      `WorkItem storage is unavailable: ${hash}`,
    );
  }
  return adapter;
}

function authorizedCompletionAdapter(
  adapter: WorkItemAdapter,
  completionWriter: Storage.WorkItemCompletionWriter,
): WorkItemAdapter {
  return {
    ...adapter,
    compareAndSet: completionWriter,
  };
}

function requiredItem(item: WorkItem.Info | undefined, hash: string): WorkItem.Info {
  if (!item) {
    throw new CompletionAdmissionError("invalid_subject", `WorkItem does not exist: ${hash}`);
  }
  return item;
}

function admissionRequired(hash: string, admissionId: string): CompletionAdmissionError {
  return new CompletionAdmissionError(
    "admission_required",
    `matching admitted completion record is required: ${hash}:${admissionId}`,
  );
}

function requestConflict(requestId: string): CompletionAdmissionError {
  return new CompletionAdmissionError(
    "request_conflict",
    `completion request conflicts with durable facts: ${requestId}`,
  );
}

function staleHead(message: string): CompletionAdmissionError {
  return new CompletionAdmissionError("stale_head", message);
}

export function completionBlockerDescription(
  admission: WorkItem.CompletionAdmission,
): string | undefined {
  if (admission.decision === "admit" || admission.decision === "owner_override") return undefined;
  return `completion admission ${admission.decision}: ${admission.reasonCodes.join(", ")}`;
}

const PersistedVerifierInput = z
  .object({
    type: z.literal("verifier_recorded_inputs"),
    version: z.literal(1),
    workItemHash: z.string().min(1),
    basisRef: z.string().min(1),
    criterionId: z.string().min(1),
    verifierKind: VerifierRegistry.ObligationKind,
    recordedInputs: z.record(VerifierRegistry.JsonValue),
  })
  .strict();

export function createDurableCompletionResultAuthorityPort(): CompletionResultAuthorityPort {
  const verifierRegistry = VerifierRegistry.create();
  return Object.freeze({
    validate(candidate: CompletionResultAuthorityCandidate) {
      const item = WorkItemStore.get(candidate.workItemHash);
      if (!item) return { ok: false };
      if (candidate.result.observationIds.length !== 1 || candidate.observations.length !== 1) {
        return { ok: false };
      }
      const observation = candidate.observations[0];
      if (!observation) return { ok: false };
      if (
        observation.id !== candidate.result.observationIds[0] ||
        observation.basisRef !== candidate.basisRef ||
        observation.subjectRef !== candidate.workItemHash
      ) {
        return { ok: false };
      }
      const evidenceId = observation?.artifactRefs[0];
      const evidence = evidenceId ? item.evidence.find(({ id }) => id === evidenceId) : undefined;
      const verifierInput =
        evidence === undefined
          ? undefined
          : durableVerifierInput(item, candidate.criterion, evidence);
      if (!observation || !verifierInput) return { ok: false };

      const verification = verifierRegistry.verify({
        obligationId: candidate.criterion.id,
        kind: verifierInput.kind,
        claim: candidate.criterion.statement,
        recordedInputs: verifierInput.recordedInputs,
      });
      if (verification.type !== "verification_result") return { ok: false };
      return {
        ok:
          verification.status === candidate.result.value &&
          verification.verifierId === candidate.result.verifierRef &&
          (candidate.result.value === "asserted" ||
            verification.checkedPredicate === candidate.result.checkedPredicate) &&
          (verifierInput.kind === "citation_support" ||
            candidate.result.value === "asserted" ||
            candidate.result.checkedPredicate === candidate.criterion.statement) &&
          observation.producer === verification.verifierId &&
          observation.artifactRefs.length === 1 &&
          observation.provenanceRef === evidenceId,
      };
    },
  });
}

export function durableVerifierInput(
  item: WorkItem.Info,
  criterion: WorkItem.Criterion,
  evidence: WorkItem.Evidence,
):
  | Readonly<{
      kind: VerifierRegistry.ObligationKind;
      recordedInputs: Record<string, VerifierRegistry.JsonValue>;
    }>
  | undefined {
  if (evidence.attempt !== item.attempt || evidence.basisRef !== item.completionContract.basisRef) {
    return undefined;
  }
  if (evidence.readBack?.kind === "citation_match") {
    if (evidence.criterionId !== criterion.id) return undefined;
    return {
      kind: "archived_quote_match",
      recordedInputs: {
        archivedText: evidence.readBack.matchedText ?? "",
        quotedText: evidence.readBack.quotedText,
      },
    };
  }
  if (evidence.detail === undefined) return undefined;
  const persisted = PersistedVerifierInput.safeParse(parseJson(evidence.detail));
  if (
    !persisted.success ||
    persisted.data.workItemHash !== item.hash ||
    persisted.data.basisRef !== item.completionContract.basisRef ||
    persisted.data.criterionId !== criterion.id
  ) {
    return undefined;
  }
  return {
    kind: persisted.data.verifierKind,
    recordedInputs: persisted.data.recordedInputs,
  };
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

export type WorkItemCompletionRecoveryReceipt = Readonly<{
  recovered: number;
  skipped: number;
  failures: readonly Readonly<{
    workItemHash: string;
    admissionId: string;
    error: string;
  }>[];
}>;

export type WorkItemCompletionGateway = CompletionAdmissionService &
  Readonly<{
    recoverRecordedCompletions(): Promise<WorkItemCompletionRecoveryReceipt>;
  }>;

type WorkItemCompletionGatewayOptions = Readonly<{
  completionWriter: Storage.WorkItemCompletionWriter;
  policyEngine: ReturnType<typeof PolicyEngine.create>;
  resultAuthorityPort?: CompletionResultAuthorityPort;
  verificationErrorAuthorityPort?: CompletionVerificationErrorAuthorityPort;
  stakesResolver?: CompletionStakesResolver;
  ownerOverrideValidator?: OwnerOverrideValidator;
  now?: () => number;
  reservation?: Readonly<{ ownerId?: string; leaseDurationMs?: number }>;
}>;

export function createWorkItemCompletionGateway(
  options: WorkItemCompletionGatewayOptions,
): WorkItemCompletionGateway {
  const now = options.now ?? Date.now;
  const recoveryOwnerId = `completion-recovery:${crypto.randomUUID()}`;
  const service = createCompletionAdmissionService({
    completionWriter: options.completionWriter,
    policyEngine: options.policyEngine,
    resultAuthorityPort: options.resultAuthorityPort,
    verificationErrorAuthorityPort: options.verificationErrorAuthorityPort,
    stakesResolver: options.stakesResolver,
    ownerOverrideValidator: options.ownerOverrideValidator,
    reservation: {
      ownerId: options.reservation?.ownerId ?? `completion-gateway:${crypto.randomUUID()}`,
      leaseDurationMs: options.reservation?.leaseDurationMs ?? DefaultCompletionLeaseDurationMs,
    },
    now,
  });
  return Object.freeze({
    ...service,
    async recoverRecordedCompletions() {
      const adapter = Storage.get().workItem;
      if (!adapter) return { recovered: 0, skipped: 0, failures: [] };
      let recovered = 0;
      let skipped = 0;
      const failures: Array<{
        workItemHash: string;
        admissionId: string;
        error: string;
      }> = [];
      for (const item of adapter.list()) {
        if (item.completionTerminalReceipt) {
          continue;
        }
        const admission = latestCurrentAdmission(item);
        if (!admission) {
          const staleReservation = item.completionFacts.requestReservations
            .filter(({ attempt, basisRef }) => {
              return attempt === item.attempt && basisRef === item.completionContract.basisRef;
            })
            .at(-1);
          if (!staleReservation) {
            if (item.completionFacts.admissions.length > 0) skipped += 1;
            continue;
          }
          const releasedAt = now();
          if (
            staleReservation.leaseExpiresAt !== undefined &&
            staleReservation.leaseExpiresAt > releasedAt
          ) {
            const released = releaseCompletionReservation(
              item,
              staleReservation,
              releasedAt,
              options.completionWriter,
              recoveryOwnerId,
            );
            if (!released) {
              failures.push({
                workItemHash: item.hash,
                admissionId: staleReservation.id,
                error: "completion reservation release lost row CAS",
              });
              continue;
            }
          }
          skipped += 1;
          continue;
        }
        if (["completed", "failed", "cancelled"].includes(WorkItem.deriveStatus(item))) {
          skipped += 1;
          continue;
        }
        if (
          item.blockers.some(
            (blocker) => !blocker.resolvedAt && blocker.id === `${admission.id}:recovery-blocker`,
          )
        ) {
          skipped += 1;
          continue;
        }
        try {
          const blockerDescription = completionBlockerDescription(admission);
          if (blockerDescription !== undefined) {
            if (
              item.blockers.some(
                (blocker) => !blocker.resolvedAt && blocker.description === blockerDescription,
              )
            ) {
              skipped += 1;
              continue;
            }
            if (
              item.revision !== admission.recordedHead &&
              admission.completionReportSnapshot !== undefined
            ) {
              if (
                !(await resumeAndSettle(
                  service,
                  item.hash,
                  admission,
                  admission.completionReportSnapshot,
                ))
              ) {
                throw new Error("completion recovery remained incomplete");
              }
              recovered += 1;
              continue;
            }
            if (
              await materializeBlocker(item.hash, `${admission.id}:blocker`, blockerDescription)
            ) {
              recovered += 1;
            } else {
              skipped += 1;
            }
            continue;
          }
          if (admission.completionReportSnapshot === undefined) {
            skipped += 1;
            continue;
          }
          if (
            await resumeAndSettle(service, item.hash, admission, admission.completionReportSnapshot)
          ) {
            recovered += 1;
          } else {
            failures.push({
              workItemHash: item.hash,
              admissionId: admission.id,
              error: "completion recovery remained incomplete",
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message.startsWith("completion report ") ||
            message.startsWith("completion terminal ")
          ) {
            if (
              await materializeBlocker(
                item.hash,
                `${admission.id}:recovery-blocker`,
                `completion recovery blocked: ${message}`,
              )
            ) {
              recovered += 1;
            } else {
              skipped += 1;
            }
            continue;
          }
          failures.push({
            workItemHash: item.hash,
            admissionId: admission.id,
            error: message,
          });
        }
      }
      return { recovered, skipped, failures };
    },
  });
}

function latestCurrentAdmission(item: WorkItem.Info): WorkItem.CompletionAdmission | undefined {
  return item.completionFacts.admissions
    .filter(
      (candidate) =>
        candidate.contractRevision === item.completionContract.revision &&
        candidate.basisRef === item.completionContract.basisRef,
    )
    .at(-1);
}

async function resumeAndSettle(
  service: CompletionAdmissionService,
  workItemHash: string,
  admission: WorkItem.CompletionAdmission,
  completionReportSnapshot: WorkItem.CompletionReport,
): Promise<boolean> {
  const outcome = await service.resumeCompletion(
    workItemHash,
    admission.id,
    completionReportSnapshot,
  );
  const reevaluated = outcome.workItem;
  if (WorkItem.deriveStatus(reevaluated) === "completed") return true;
  const latest = latestCurrentAdmission(reevaluated);
  const description = latest === undefined ? undefined : completionBlockerDescription(latest);
  if (
    latest !== undefined &&
    description !== undefined &&
    (await materializeBlocker(workItemHash, `${latest.id}:blocker`, description))
  ) {
    return true;
  }
  return false;
}

async function materializeBlocker(
  workItemHash: string,
  blockerId: string,
  description: string,
): Promise<boolean> {
  const current = WorkItemStore.get(workItemHash);
  if (
    current?.blockers.some((blocker) => !blocker.resolvedAt && blocker.description === description)
  ) {
    return false;
  }
  await WorkItemStore.addBlocker(workItemHash, {
    id: blockerId,
    description,
    kind: "error",
  });
  return true;
}
