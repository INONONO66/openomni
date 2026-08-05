import type { PolicyEngine } from "@openomni/policy";
import { WorkItem, type Execution } from "@openomni/protocol";
import { type Storage, WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { VerifierRegistry } from "../../evidence/verifier-registry.js";
import {
  createCompletionAuthorityResolver,
  type CompletionResultAuthorityCandidate,
  type CompletionResultAuthorityPort,
  type CompletionStakesResolver,
  type CompletionVerificationErrorAuthorityCandidate,
  type CompletionVerificationErrorAuthorityPort,
} from "../../work-item/completion-admission-authority.js";
import {
  createCompletionAdmissionService,
  CompletionAdmissionServiceError,
  type CompletionBoundaryOutcome,
} from "../../work-item/completion-admission-boundary.js";
import {
  type CompletionSourceOrigin,
  projectCompletionOrigin,
  projectCompletionSourceIdentity,
} from "../../work-item/completion-origin.js";

const VerificationInput = z
  .object({
    kind: VerifierRegistry.ObligationKind,
  })
  .strict();

const EvidenceReference = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("work_item"),
      evidenceId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      source: z.literal("read_back"),
      requestIndex: z.number().int().nonnegative(),
    })
    .strict(),
]);

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

class CompletionReplayRequiresReservation extends Error {}

export const WorkerCriterionFactInput = z
  .object({
    criterionIndex: z.number().int().nonnegative(),
    evidenceRefs: z.array(EvidenceReference).length(1),
    verification: VerificationInput,
  })
  .strict();
export type WorkerCriterionFactInput = z.infer<typeof WorkerCriterionFactInput>;

export type WorkerReadBackEvidenceBinding = Readonly<{
  evidenceId: string;
  criterionIndex: number;
}>;

export type WorkerCompletionAdmissionInput = Readonly<{
  beforeAdmissionWrite?: () => void;
  completionWriter: Storage.WorkItemCompletionWriter;
  workItemHash: string;
  result: Execution.Result;
  completionEnvelopeDigest: string;
  sourceOrigin: CompletionSourceOrigin;
  criterionFacts: readonly WorkerCriterionFactInput[];
  completionReport: WorkItem.CompletionReport;
  policyEngine: ReturnType<typeof PolicyEngine.create>;
  readBackEvidenceBindings?: ReadonlyMap<number, WorkerReadBackEvidenceBinding>;
  stakesResolver?: CompletionStakesResolver;
  now: () => number;
}>;

type TrustedResult = Readonly<{
  criterion: WorkItem.Criterion;
  result: WorkItem.CriterionResult;
  observations: readonly WorkItem.Observation[];
}>;

type ProjectedFacts = Readonly<{
  claims: readonly WorkItem.Claim[];
  observations: readonly WorkItem.Observation[];
  results: readonly WorkItem.CriterionResult[];
  verificationErrors: readonly WorkItem.VerificationErrorFact[];
  authorityPort: CompletionResultAuthorityPort;
  verificationErrorAuthorityPort: CompletionVerificationErrorAuthorityPort;
}>;

export async function admitWorkerCompletion(
  input: WorkerCompletionAdmissionInput,
): Promise<CompletionBoundaryOutcome> {
  const item = requireWorkerCompletionIdentity(input.workItemHash, input.result);
  const createdAt = input.now();
  const requestId = workerCompletionRequestId(item, input.result, input.completionEnvelopeDigest);
  const projected = projectCriterionFacts(
    item,
    requestId,
    input.criterionFacts,
    input.readBackEvidenceBindings ?? new Map(),
    createdAt,
  );
  const request = WorkItem.CompletionRequest.parse({
    version: 1,
    id: requestId,
    origin: projectCompletionOrigin(input.sourceOrigin),
    sourceIdentity: workerCompletionSourceIdentity(input.sourceOrigin, input.result),
    workItemHash: item.hash,
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    expectedHead: item.revision,
    claims: projected.claims,
    observations: projected.observations,
    results: projected.results,
    invalidations: [],
    verificationErrors: projected.verificationErrors,
    effects: [],
  });
  const authorityResolver = createCompletionAuthorityResolver({
    policyEngine: input.policyEngine,
    resultAuthorityPort: projected.authorityPort,
    verificationErrorAuthorityPort: projected.verificationErrorAuthorityPort,
    ...(input.stakesResolver === undefined ? {} : { stakesResolver: input.stakesResolver }),
    now: input.now,
  });
  const service = createCompletionAdmissionService({
    completionWriter: input.completionWriter,
    authorityResolver,
    beforeAdmissionWrite: input.beforeAdmissionWrite,
    now: input.now,
  });
  return service.requestCompletion(request, input.completionReport);
}

function workerCompletionSourceIdentity(
  sourceOrigin: CompletionSourceOrigin,
  result: Execution.Result,
): WorkItem.CompletionSourceIdentity | undefined {
  if (sourceOrigin.source === "internal_worker" || sourceOrigin.source === "connector_worker") {
    return WorkItem.CompletionSourceIdentity.parse({
      source: sourceOrigin.source,
      identity: {
        kind: "worker",
        id: `${result.sessionId}:${result.runId}`,
      },
    });
  }
  return projectCompletionSourceIdentity(sourceOrigin);
}

export async function replayWorkerCompletion(
  input: Pick<
    WorkerCompletionAdmissionInput,
    | "completionWriter"
    | "beforeAdmissionWrite"
    | "workItemHash"
    | "result"
    | "completionEnvelopeDigest"
    | "policyEngine"
    | "stakesResolver"
    | "now"
  > &
    Readonly<{
      completionReportMatches(report: WorkItem.CompletionReport): boolean;
    }>,
): Promise<CompletionBoundaryOutcome | undefined> {
  const item = requireWorkerCompletionIdentity(input.workItemHash, input.result);
  const requestRoot = workerCompletionRequestRoot(item, input.result);
  const requestId = `${requestRoot}:${input.completionEnvelopeDigest}`;
  const admission = item.completionFacts.admissions.find(
    (candidate) => candidate.requestId === requestId,
  );
  if (!admission) {
    const correlatedAdmission = item.completionFacts.admissions.find((candidate) =>
      candidate.requestId.startsWith(`${requestRoot}:`),
    );
    if (!correlatedAdmission) return undefined;
    throw new CompletionAdmissionServiceError(
      "request_conflict",
      `completion envelope changed for request: ${requestRoot}`,
    );
  }
  const report = admission.completionReportSnapshot;
  if (!report) throw new Error(`completion admission report is missing: ${admission.id}`);
  if (!input.completionReportMatches(report)) {
    throw new CompletionAdmissionServiceError(
      "request_conflict",
      `completion report changed for request: ${requestId}`,
    );
  }
  const blockerDescription = completionAdmissionBlockerDescription(admission);
  if (
    blockerDescription !== undefined &&
    item.revision === admission.recordedHead + 1 &&
    item.blockers.some(
      (blocker) => blocker.resolvedAt === undefined && blocker.description === blockerDescription,
    )
  ) {
    return { admission, workItem: item, completed: false };
  }
  const authorityResolver = createCompletionAuthorityResolver({
    policyEngine: input.policyEngine,
    resultAuthorityPort: createDurableCompletionResultAuthorityPort(),
    ...(input.stakesResolver === undefined ? {} : { stakesResolver: input.stakesResolver }),
    now: input.now,
  });
  const service = createCompletionAdmissionService({
    completionWriter: input.completionWriter,
    authorityResolver,
    beforeAdmissionWrite:
      input.beforeAdmissionWrite ??
      (() => {
        throw new CompletionReplayRequiresReservation();
      }),
    now: input.now,
  });
  try {
    return await service.requestCompletion(admission.requestSnapshot, report);
  } catch (error) {
    if (error instanceof CompletionReplayRequiresReservation) return undefined;
    throw error;
  }
}

function completionAdmissionBlockerDescription(
  admission: WorkItem.CompletionAdmission,
): string | undefined {
  if (admission.decision === "admit" || admission.decision === "owner_override") return undefined;
  return `completion admission ${admission.decision}: ${admission.reasonCodes.join(", ")}`;
}

export function workerCompletionRequestId(
  item: WorkItem.Info,
  result: Execution.Result,
  completionEnvelopeDigest: string,
): string {
  return `${workerCompletionRequestRoot(item, result)}:${completionEnvelopeDigest}`;
}

export function workerCompletionRequestRoot(item: WorkItem.Info, result: Execution.Result): string {
  return `completion-request:${item.hash}:${result.runId}:${result.sessionId}`;
}

export function requireWorkerCompletionIdentity(
  workItemHash: string,
  result: Execution.Result,
): WorkItem.Info {
  const item = WorkItemStore.get(workItemHash);
  if (!item) throw new Error(`WorkItem not found: ${workItemHash}`);
  if (item.workerRunId === result.runId && item.workSessionId === result.sessionId) return item;
  throw new Error(
    `Worker completion identity mismatch: expected ${item.workerRunId ?? "missing"}/${item.workSessionId ?? "missing"}, received ${result.runId}/${result.sessionId}`,
  );
}

function projectCriterionFacts(
  item: WorkItem.Info,
  requestId: string,
  inputs: readonly WorkerCriterionFactInput[],
  readBackEvidenceBindings: ReadonlyMap<number, WorkerReadBackEvidenceBinding>,
  createdAt: number,
): ProjectedFacts {
  const registry = VerifierRegistry.create();
  const claims: WorkItem.Claim[] = [];
  const observations: WorkItem.Observation[] = [];
  const results: WorkItem.CriterionResult[] = [];
  const verificationErrors: WorkItem.VerificationErrorFact[] = [];
  const trustedResults = new Map<string, TrustedResult>();
  const trustedVerificationErrors = new Map<
    string,
    Readonly<{ criterion: WorkItem.Criterion; error: WorkItem.VerificationErrorFact }>
  >();

  for (const [index, input] of inputs.entries()) {
    const criterion = item.completionFacts.criteria[input.criterionIndex];
    if (!criterion) throw new Error(`completion criterion is unknown: ${input.criterionIndex}`);
    const factRef = `${requestId}:${index}`;
    const obligationId = `obligation:${factRef}`;
    const evidence = resolveVerifierEvidence(item, input, readBackEvidenceBindings);
    const recordedInputs = recordedInputsFromEvidence(item, criterion, input, evidence);
    const verification = registry.verify({
      obligationId,
      kind: input.verification.kind,
      claim: criterion.statement,
      recordedInputs,
    });
    if (verification.type === "verification_error") {
      claims.push({
        id: `claim:${factRef}`,
        criterionId: criterion.id,
        statement: criterion.statement,
        observationIds: [],
        basisRef: item.completionContract.basisRef,
        createdAt,
      });
      const error = WorkItem.VerificationErrorFact.parse({
        id: `verification-error:${factRef}`,
        criterionId: criterion.id,
        code: verification.code,
        detail: verification.detail,
        ...(verification.verifierId === undefined ? {} : { verifierRef: verification.verifierId }),
        basisRef: item.completionContract.basisRef,
        createdAt,
      });
      verificationErrors.push(error);
      trustedVerificationErrors.set(error.id, { criterion, error });
      continue;
    }
    if (
      verification.status !== "asserted" &&
      verification.kind !== "citation_support" &&
      verification.checkedPredicate !== criterion.statement
    ) {
      claims.push({
        id: `claim:${factRef}`,
        criterionId: criterion.id,
        statement: criterion.statement,
        observationIds: [],
        basisRef: item.completionContract.basisRef,
        createdAt,
      });
      const error = WorkItem.VerificationErrorFact.parse({
        id: `verification-error:${factRef}`,
        criterionId: criterion.id,
        code: "malformed_output",
        detail: "verifier checked predicate does not exactly match persisted criterion statement",
        verifierRef: verification.verifierId,
        basisRef: item.completionContract.basisRef,
        createdAt,
      });
      verificationErrors.push(error);
      trustedVerificationErrors.set(error.id, { criterion, error });
      continue;
    }

    const observation: WorkItem.Observation = {
      id: `observation:${factRef}`,
      producer: verification.verifierId,
      subjectRef: item.hash,
      basisRef: item.completionContract.basisRef,
      artifactRefs: [evidence.id],
      provenanceRef: evidence.id,
      ancestryRefs: [],
      observedAt: createdAt,
    };
    const claim: WorkItem.Claim = {
      id: `claim:${factRef}`,
      criterionId: criterion.id,
      statement: criterion.statement,
      observationIds: [observation.id],
      basisRef: item.completionContract.basisRef,
      createdAt,
    };
    const resultBase = {
      id: `result:${factRef}`,
      criterionId: criterion.id,
      observationIds: [observation.id],
      verifierRef: verification.verifierId,
      assumptions: [],
      basisRef: item.completionContract.basisRef,
      createdAt,
    };
    const result = WorkItem.CriterionResult.parse(
      verification.status === "asserted"
        ? {
            ...resultBase,
            value: "asserted",
            residualRisks: ["asserted-only criterion result"],
          }
        : {
            ...resultBase,
            value: verification.status,
            checkedPredicate: requiredCheckedPredicate(verification),
            residualRisks: [],
          },
    );
    claims.push(claim);
    observations.push(observation);
    results.push(result);
    trustedResults.set(result.id, { criterion, result, observations: [observation] });
  }

  return {
    claims,
    observations,
    results,
    verificationErrors,
    authorityPort: resultAuthorityPort(trustedResults),
    verificationErrorAuthorityPort: verificationErrorAuthorityPort(trustedVerificationErrors),
  };
}

function resolveVerifierEvidence(
  item: WorkItem.Info,
  input: WorkerCriterionFactInput,
  readBackEvidenceBindings: ReadonlyMap<number, WorkerReadBackEvidenceBinding>,
): WorkItem.Evidence {
  const reference = input.evidenceRefs[0];
  if (!reference) throw new Error("one verifier evidence reference is required");
  const binding =
    reference.source === "read_back"
      ? readBackEvidenceBindings.get(reference.requestIndex)
      : undefined;
  if (
    binding !== undefined &&
    reference.source === "read_back" &&
    binding.criterionIndex !== input.criterionIndex
  ) {
    throw new Error(
      `read-back evidence criterion binding mismatch: request ${reference.requestIndex}`,
    );
  }
  const evidenceId = reference.source === "work_item" ? reference.evidenceId : binding?.evidenceId;
  if (!evidenceId) {
    const identifier =
      reference.source === "work_item"
        ? reference.evidenceId
        : `read-back request ${reference.requestIndex}`;
    throw new Error(`verifier evidence not found: ${identifier}`);
  }
  const evidence = item.evidence.find((candidate) => candidate.id === evidenceId);
  if (!evidence) throw new Error(`verifier evidence not found: ${evidenceId}`);
  return evidence;
}

function recordedInputsFromEvidence(
  item: WorkItem.Info,
  criterion: WorkItem.Criterion,
  input: WorkerCriterionFactInput,
  evidence: WorkItem.Evidence,
): Record<string, VerifierRegistry.JsonValue> {
  if (evidence.readBack) {
    return recordedInputsFromReadBack(input.verification.kind, evidence);
  }
  if (!evidence.detail) throw new Error(`verifier evidence is malformed: ${evidence.id}`);
  const decoded = parseJson(evidence.detail);
  const persisted = PersistedVerifierInput.safeParse(decoded);
  if (!persisted.success) throw new Error(`verifier evidence is malformed: ${evidence.id}`);
  const mismatched =
    persisted.data.workItemHash !== item.hash ||
    persisted.data.basisRef !== item.completionContract.basisRef ||
    persisted.data.criterionId !== criterion.id ||
    persisted.data.verifierKind !== input.verification.kind;
  if (mismatched) throw new Error(`verifier evidence does not match criterion: ${evidence.id}`);
  return persisted.data.recordedInputs;
}

function recordedInputsFromReadBack(
  verifierKind: VerifierRegistry.ObligationKind,
  evidence: WorkItem.Evidence,
): Record<string, VerifierRegistry.JsonValue> {
  const readBack = evidence.readBack;
  if (readBack?.kind !== "citation_match") {
    throw new Error(`verifier evidence is not a supported read-back record: ${evidence.id}`);
  }
  if (verifierKind !== "archived_quote_match") {
    throw new Error(`verifier evidence does not match read-back kind: ${evidence.id}`);
  }
  if (!readBack.passed || readBack.matchedText === undefined) {
    throw new Error(`read-back verifier evidence did not pass: ${evidence.id}`);
  }
  return {
    archivedText: readBack.matchedText,
    quotedText: readBack.quotedText,
  };
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function requiredCheckedPredicate(verification: VerifierRegistry.VerificationResult): string {
  if (verification.checkedPredicate === undefined) {
    throw new Error(
      `decisive verifier result has no checked predicate: ${verification.obligationId}`,
    );
  }
  return verification.checkedPredicate;
}

function resultAuthorityPort(
  trustedResults: ReadonlyMap<string, TrustedResult>,
): CompletionResultAuthorityPort {
  return Object.freeze({
    validate(candidate: CompletionResultAuthorityCandidate) {
      const trusted = trustedResults.get(candidate.result.id);
      return {
        ok:
          trusted !== undefined &&
          equal(candidate.criterion, trusted.criterion) &&
          equal(candidate.result, trusted.result) &&
          equal(candidate.observations, trusted.observations),
      };
    },
  });
}

export function createDurableCompletionResultAuthorityPort(): CompletionResultAuthorityPort {
  const verifierRegistry = VerifierRegistry.create();
  return Object.freeze({
    validate(candidate: CompletionResultAuthorityCandidate) {
      const item = WorkItemStore.get(candidate.workItemHash);
      if (!item) return { ok: false };
      const observation = candidate.observations.find(({ id }) =>
        candidate.result.observationIds.includes(id),
      );
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
          observation.producer === verification.verifierId,
      };
    },
  });
}

function durableVerifierInput(
  item: WorkItem.Info,
  criterion: WorkItem.Criterion,
  evidence: WorkItem.Evidence,
):
  | Readonly<{
      kind: VerifierRegistry.ObligationKind;
      recordedInputs: Record<string, VerifierRegistry.JsonValue>;
    }>
  | undefined {
  if (evidence.readBack?.kind === "citation_match") {
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

function verificationErrorAuthorityPort(
  trustedErrors: ReadonlyMap<
    string,
    Readonly<{ criterion: WorkItem.Criterion; error: WorkItem.VerificationErrorFact }>
  >,
): CompletionVerificationErrorAuthorityPort {
  return Object.freeze({
    validate(candidate: CompletionVerificationErrorAuthorityCandidate) {
      const trusted = trustedErrors.get(candidate.error.id);
      return {
        ok:
          trusted !== undefined &&
          equal(candidate.criterion, trusted.criterion) &&
          equal(candidate.error, trusted.error),
      };
    },
  });
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
