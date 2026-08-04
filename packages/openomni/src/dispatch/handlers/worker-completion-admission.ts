import type { PolicyEngine } from "@openomni/policy";
import { WorkItem, type Execution } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { VerifierRegistry } from "../../evidence/verifier-registry.js";
import {
  createCompletionAdmissionService,
  createCompletionAuthorityResolver,
  type CompletionBoundaryOutcome,
  type CompletionResultAuthorityCandidate,
  type CompletionResultAuthorityPort,
  type CompletionStakesResolver,
} from "../../work-item/index.js";
import {
  type CompletionSourceOrigin,
  projectCompletionOrigin,
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
  workItemHash: string;
  result: Execution.Result;
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
}>;

export async function admitWorkerCompletion(
  input: WorkerCompletionAdmissionInput,
): Promise<CompletionBoundaryOutcome> {
  const item = WorkItemStore.get(input.workItemHash);
  if (!item) throw new Error(`WorkItem not found: ${input.workItemHash}`);
  const createdAt = input.now();
  const requestId = `completion-request:${item.hash}:${input.result.runId}:${item.revision}`;
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
    ...(input.stakesResolver === undefined ? {} : { stakesResolver: input.stakesResolver }),
    now: input.now,
  });
  const service = createCompletionAdmissionService({ authorityResolver, now: input.now });
  return service.requestCompletion(request, input.completionReport);
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
      verificationErrors.push({
        id: `verification-error:${factRef}`,
        criterionId: criterion.id,
        code: verification.code,
        detail: verification.detail,
        ...(verification.verifierId === undefined ? {} : { verifierRef: verification.verifierId }),
        basisRef: item.completionContract.basisRef,
        createdAt,
      });
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
      verificationErrors.push({
        id: `verification-error:${factRef}`,
        criterionId: criterion.id,
        code: "malformed_output",
        detail: "verifier checked predicate does not exactly match persisted criterion statement",
        verifierRef: verification.verifierId,
        basisRef: item.completionContract.basisRef,
        createdAt,
      });
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

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
