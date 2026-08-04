import type { PolicyEngine } from "@openomni/policy";
import { WorkItem, type Policy } from "@openomni/protocol";

import type { CompletionStakesInjection } from "../ledger/index.js";
import { canonicalCompletionRequest } from "./completion-request-identity.js";
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
  | "unsupported_fact";

export class CompletionAdmissionError extends Error {
  readonly name = "CompletionAdmissionError";

  constructor(
    readonly code: CompletionAdmissionErrorCode,
    message: string,
  ) {
    super(message);
  }
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

type OwnerOverrideValidation = Readonly<{ ok: true; receiptRef: string }> | Readonly<{ ok: false }>;

type OwnerOverrideAuthorityPort = Readonly<{
  validate(
    candidate: Readonly<{
      receiptRef: string;
      workItemHash: string;
      requestId: string;
      contractRevision: string;
      basisRef: string;
    }>,
  ): OwnerOverrideValidation | Promise<OwnerOverrideValidation>;
}>;

export type CompletionAuthorityDependencies = Readonly<{
  policyEngine: ReturnType<typeof PolicyEngine.create>;
  stakesResolver?: CompletionStakesResolver;
  resultAuthorityPort?: CompletionResultAuthorityPort;
  ownerOverrideAuthorityPort?: OwnerOverrideAuthorityPort;
  now?: () => number;
}>;

export type CompletionAuthorityResolver = Readonly<{
  resolve(
    item: WorkItem.Info,
    request: WorkItem.CompletionRequest,
  ): Promise<WorkItem.CompletionAdmission>;
}>;

type CompletionCandidate = Readonly<{
  effectiveResultIds: readonly string[];
  unresolvedCriterionIds: readonly string[];
  reasonCodes: readonly string[];
  assertedCriterionIds: readonly string[];
  proposedFactIds: readonly string[];
  stakes?: NonNullable<CompletionEvaluationInput["stakes"]>;
}>;

const EMPTY_POLICY: CompletionPolicy = Object.freeze({
  policyRef: "completion.pre-fold",
  verdict: "allow",
  allowedAssertedCriterionIds: [],
  reasonCodes: [],
});

export function createCompletionAuthorityResolver(
  dependencies: CompletionAuthorityDependencies,
): CompletionAuthorityResolver {
  const now = dependencies.now ?? Date.now;

  return Object.freeze({
    async resolve(itemInput, requestInput) {
      const item = WorkItem.Info.parse(itemInput);
      const request = WorkItem.CompletionRequest.parse(requestInput);
      assertCurrentRequest(item, request);
      assertRequesterFactsSupported(request);
      assertProposedFacts(item, request);
      assertUniqueFactIds(item, request);
      await assertProposedResultAuthority(dependencies.resultAuthorityPort, item, request);

      const foldInput = completionInput(item, request, now());
      const preAdmission = foldCompletion(foldInput);
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
      const ownerOverride = await resolveOwnerOverride(
        dependencies.ownerOverrideAuthorityPort,
        request,
      );

      return foldCompletion({
        ...foldInput,
        policy: completionPolicy(policyDecision),
        ...(stakes ? { stakes } : {}),
        ...(ownerOverride ? { ownerOverride } : {}),
      });
    },
  });
}

function assertCurrentRequest(item: WorkItem.Info, request: WorkItem.CompletionRequest): void {
  if (request.workItemHash !== item.hash) {
    throw new CompletionAdmissionError(
      "invalid_subject",
      `completion request subject ${request.workItemHash} does not match ${item.hash}`,
    );
  }
  if (request.expectedHead !== item.revision) {
    throw new CompletionAdmissionError(
      "stale_head",
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

function assertRequesterFactsSupported(request: WorkItem.CompletionRequest): void {
  if (request.invalidations.length > 0) {
    throw new CompletionAdmissionError(
      "unsupported_fact",
      "proposed result invalidations require trusted invalidation authority",
    );
  }
  if (request.effects.length > 0) {
    throw new CompletionAdmissionError(
      "unsupported_fact",
      "proposed effects require trusted effect authority",
    );
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

function assertUniqueFactIds(item: WorkItem.Info, request: WorkItem.CompletionRequest): void {
  const facts: readonly Readonly<{ id: string }>[] = [
    ...item.completionFacts.criteria,
    ...item.completionFacts.claims,
    ...item.completionFacts.observations,
    ...item.completionFacts.results,
    ...item.completionFacts.invalidations,
    ...item.completionFacts.verificationErrors,
    ...item.completionFacts.effects,
    ...item.completionFacts.admissions,
    ...request.claims,
    ...request.observations,
    ...request.results,
    ...request.invalidations,
    ...request.verificationErrors,
    ...request.effects,
  ];
  const ids = new Set<string>();
  for (const fact of facts) {
    if (ids.has(fact.id)) {
      throw new CompletionAdmissionError("duplicate_fact_id", `duplicate fact id: ${fact.id}`);
    }
    ids.add(fact.id);
  }
}

async function assertProposedResultAuthority(
  port: CompletionResultAuthorityPort | undefined,
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
): Promise<void> {
  const proposedResults = request.results.filter((result) => result.value !== "asserted");
  if (proposedResults.length === 0) return;
  if (!port) {
    throw new CompletionAdmissionError(
      "invalid_verifier",
      "proposed non-asserted results require result authority",
    );
  }

  const observations = [...item.completionFacts.observations, ...request.observations];
  for (const result of proposedResults) {
    const criterion = item.completionFacts.criteria.find(
      (candidate) => candidate.id === result.criterionId,
    );
    const resolvedObservations = result.observationIds.flatMap((observationId) => {
      const observation = observations.find((candidate) => candidate.id === observationId);
      return observation ? [observation] : [];
    });
    if (
      result.observationIds.length === 0 ||
      result.verifierRef === undefined ||
      criterion === undefined ||
      resolvedObservations.length !== result.observationIds.length
    ) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        `proposed result ${result.id} has no authoritative verifier basis`,
      );
    }
    const validation = await port.validate({
      workItemHash: item.hash,
      requestId: request.id,
      contractRevision: request.contractRevision,
      basisRef: request.basisRef,
      criterion,
      result,
      observations: resolvedObservations,
    });
    if (!validation.ok) {
      throw new CompletionAdmissionError(
        "invalid_verifier",
        `result authority rejected ${result.id}`,
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
    requestSnapshot: canonicalCompletionRequest(request),
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
): Promise<CompletionEvaluationInput["stakes"]> {
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
  };
}

async function resolveOwnerOverride(
  port: OwnerOverrideAuthorityPort | undefined,
  request: WorkItem.CompletionRequest,
): Promise<CompletionEvaluationInput["ownerOverride"]> {
  const receiptRef = request.ownerOverrideReceiptRef;
  if (!port || receiptRef === undefined) return undefined;
  const candidate = {
    receiptRef,
    workItemHash: request.workItemHash,
    requestId: request.id,
    contractRevision: request.contractRevision,
    basisRef: request.basisRef,
  } as const;
  const validation = await port.validate(candidate);
  if (!validation.ok || validation.receiptRef !== receiptRef) return undefined;
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
