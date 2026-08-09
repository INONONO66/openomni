import { createHash } from "node:crypto";
import { WorkItem, type Execution } from "@openomni/protocol";
import { WorkItemStore } from "@openomni/session";
import { z } from "zod";
import { ReadBackExecutor } from "../../evidence/read-back-executor.js";
import { settleBeforeDeadline } from "../../evidence/read-back-http.js";
import { canonicalJson as canonicalEvidenceJson } from "../../evidence/verifier-conformance-canonical.js";
import { VerifierRegistry } from "../../evidence/verifier-registry.js";
import {
  CompletionAdmissionError,
  completionBlockerDescription,
  durableVerifierInput,
  type CompletionAdmissionService,
  type CompletionBoundaryOutcome,
  type CompletionRequestCallOptions,
  type CompletionVerificationErrorAuthorityCandidate,
  type CompletionVerificationErrorAuthorityPort,
} from "../../work-item/completion-admission.js";

const MAX_READ_BACK_REQUESTS = 5;
const MAX_READ_BACK_TIMEOUT_MS = 10_000;
const MAX_READ_BACK_BODY_BYTES = 1_000_000;

const ReadBackRequest = WorkItem.ReadBackRequest.superRefine((request, ctx) => {
  if (request.timeoutMs !== undefined && request.timeoutMs > MAX_READ_BACK_TIMEOUT_MS) {
    ctx.addIssue({
      code: "custom",
      message: `read-back timeoutMs must be at most ${MAX_READ_BACK_TIMEOUT_MS}`,
      path: ["timeoutMs"],
    });
  }
  if (request.maxBodyBytes > MAX_READ_BACK_BODY_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `read-back maxBodyBytes must be at most ${MAX_READ_BACK_BODY_BYTES}`,
      path: ["maxBodyBytes"],
    });
  }
});

type ReadBackRequest = z.infer<typeof ReadBackRequest>;

const ReadBackRequestEnvelope = WorkItem.ReadBackRequestEnvelope.extend({
  request: ReadBackRequest,
});

const CompletionReportDraft = z
  .object({
    summary: z.string().min(1),
    claims: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            evidenceIds: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(1),
    caveats: z.array(z.string().min(1)).default([]),
    followUps: z.array(z.string().min(1)).default([]),
  })
  .strict();

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

const WorkerCriterionFactInput = z
  .object({
    criterionIndex: z.number().int().nonnegative(),
    evidenceRefs: z.array(EvidenceReference).length(1),
    verification: VerificationInput,
  })
  .strict();
type WorkerCriterionFactInput = z.infer<typeof WorkerCriterionFactInput>;

const CompletionEnvelope = z
  .object({
    deliverable: z.unknown().optional(),
    completionReport: CompletionReportDraft,
    criterionFacts: z.array(WorkerCriterionFactInput).min(1).max(256),
    readBackRequests: z.array(ReadBackRequestEnvelope).max(MAX_READ_BACK_REQUESTS).default([]),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    const criterionIndexes = new Set<number>();
    for (const [factIndex, fact] of envelope.criterionFacts.entries()) {
      if (criterionIndexes.has(fact.criterionIndex)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate criterionIndex ${fact.criterionIndex}`,
          path: ["criterionFacts", factIndex, "criterionIndex"],
        });
      }
      criterionIndexes.add(fact.criterionIndex);
    }
    for (const [requestIndex, readBack] of envelope.readBackRequests.entries()) {
      if (readBack.claimIndex >= envelope.completionReport.claims.length) {
        ctx.addIssue({
          code: "custom",
          message: "read-back request claimIndex is out of range",
          path: ["readBackRequests", requestIndex, "claimIndex"],
        });
      }
    }
  });

type CompletionEnvelope = z.infer<typeof CompletionEnvelope>;
type CompletionReportDraft = z.infer<typeof CompletionReportDraft>;
type WorkItemStatus = ReturnType<typeof WorkItem.deriveStatus>;
type ParsedCompletionEnvelope =
  | { readonly ok: true; readonly envelope: CompletionEnvelope }
  | { readonly ok: false; readonly reason: string };

type WorkerReadBackEvidenceBinding = Readonly<{
  evidenceId: string;
  criterionIndex: number;
}>;

export interface WorkerCompletionOptions {
  readonly completionService?: CompletionAdmissionService;
  /** Shared deterministic verifier registry (#549); constructed at dispatch setup, never per call. */
  readonly verifierRegistry: VerifierRegistry.Registry;
  readonly sourceOrigin: WorkItem.CompletionSourceOrigin;
  readonly readBack?: ReadBackExecutor.Options;
  readonly readBackEnvelopeTimeoutMs?: number;
  readonly readBackRecorder?: (
    workItemHash: string,
    input: Parameters<typeof ReadBackExecutor.execute>[0],
    options?: ReadBackExecutor.Options,
  ) => Promise<WorkItem.ReadBackCheck>;
  readonly now?: () => number;
}

export type CompletionReflection = {
  readonly workItemStatus?: WorkItemStatus;
  readonly completionBlocked: boolean;
  readonly completionBlocker?: string;
};

export async function reflectCoordinatorResult(
  workItemHash: string,
  result: Execution.Result,
  options: WorkerCompletionOptions,
): Promise<CompletionReflection> {
  let item: WorkItem.Info;
  let sourceOrigin: WorkItem.CompletionSourceOrigin;
  try {
    sourceOrigin = WorkItem.CompletionSourceOrigin.parse(options.sourceOrigin);
    item = requireWorkerCompletionIdentity(workItemHash, result);
  } catch (error) {
    return completionReflection(
      workItemHash,
      true,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (result.status === "succeeded") {
    const completionService = options.completionService;
    if (!completionService) {
      return blockCompletion(workItemHash, "completion writer is unavailable");
    }
    const parsed = parseCompletionEnvelope(result);
    if (!parsed.ok) {
      return blockCompletion(workItemHash, parsed.reason);
    }
    const requestRoot = workerCompletionRequestRoot(item, result);
    const reservationRoot = workerCompletionReservationRoot(item, result, sourceOrigin);
    try {
      const now = options.now ?? Date.now;
      const completionEnvelopeDigest = digestCompletionEnvelope(parsed.envelope);
      const requestId = workerCompletionRequestId(item, result);
      assertDurableSourceIdentity(item, requestId, sourceOrigin, result);
      const leaseDurationMs = resolveReadBackEnvelopeTimeoutMs(options) + 5_000;
      const reservation = completionService.reserveRequest({
        workItemHash,
        requestId,
        requestRoot: reservationRoot,
        envelopeDigest: completionEnvelopeDigest,
        leaseDurationMs,
      });
      if (reservation.state === "admitted") {
        if (reservation.reservation.envelopeDigest === completionEnvelopeDigest) {
          // Byte-identical redelivery of an envelope whose admission already
          // reached the durable terminal receipt: reply from durable state
          // without re-projecting facts (registry.verify) or re-entering the
          // admission service, so the retry stays idempotent even if verifier
          // behavior evolves or verification throws.
          return completionReflection(workItemHash, false);
        }
        // Digest mismatch: fall through to the full path so conflict
        // detection (completion envelope changed) is preserved.
        const replayed = replayPreparedReport(requestRoot, parsed.envelope);
        const outcome = await admitWorkerCompletion({
          completionService,
          verifierRegistry: options.verifierRegistry,
          requestId,
          workItemHash,
          result,
          sourceOrigin,
          criterionFacts: parsed.envelope.criterionFacts,
          completionReport: replayed.report,
          readBackEvidenceBindings: replayed.readBackEvidenceBindings,
          now,
        });
        return completionOutcomeReflection(workItemHash, outcome);
      }
      if (
        reservation.state === "busy" ||
        (reservation.state === "existing" && completionService.hasActiveRequest(requestId))
      ) {
        return completionReflection(
          workItemHash,
          true,
          `completion request is already in progress: ${requestId}`,
        );
      }
      const assertLease = () =>
        completionService.assertReservationLease({
          workItemHash,
          requestId,
          reservationId: reservation.reservation.id,
          fence: reservation.reservation.fence,
        });
      const completionReservation = {
        leaseDurationMs,
        requestRoot: reservationRoot,
        envelopeDigest: completionEnvelopeDigest,
      };
      const invocationToken = reservation.reservation.id;
      const releaseActiveRequest = completionService.trackActiveRequest(requestId, invocationToken);
      try {
        const prepared = await prepareCompletionReport(
          workItemHash,
          requestRoot,
          parsed.envelope,
          options,
          assertLease,
        );
        assertLease();
        const outcome = await admitWorkerCompletion({
          beforeAdmissionWrite: assertLease,
          completionReservation,
          completionService,
          verifierRegistry: options.verifierRegistry,
          requestId,
          workItemHash,
          result,
          sourceOrigin,
          criterionFacts: parsed.envelope.criterionFacts,
          completionReport: prepared.report,
          readBackEvidenceBindings: prepared.readBackEvidenceBindings,
          now,
        });
        return completionOutcomeReflection(workItemHash, outcome);
      } finally {
        releaseActiveRequest();
      }
    } catch (err) {
      if (
        err instanceof CompletionAdmissionError &&
        (err.code === "stale_basis" ||
          (err.code === "request_conflict" &&
            err.message.startsWith("completion reservation lease lost:")))
      ) {
        return completionReflection(workItemHash, true, err.message);
      }
      if (
        err instanceof CompletionAdmissionError &&
        err.code === "authority_unavailable" &&
        parsed.envelope.readBackRequests.length > 0 &&
        parsed.envelope.readBackRequests.every((_, requestIndex) =>
          WorkItemStore.get(workItemHash)?.evidence.some(
            ({ id }) => id === readBackEvidenceId(requestRoot, requestIndex),
          ),
        )
      ) {
        return completionReflection(
          workItemHash,
          true,
          err instanceof Error ? err.message : String(err),
        );
      }
      return blockCompletion(workItemHash, err instanceof Error ? err.message : String(err));
    }
  }
  if (result.status === "cancelled") {
    await WorkItemStore.cancel(workItemHash);
    return completionReflection(workItemHash, false);
  }
  if (result.status === "failed" || result.status === "interrupted") {
    await WorkItemStore.fail(workItemHash, result.error ?? result.status);
  }
  return completionReflection(workItemHash, false);
}

type WorkerCompletionAdmissionInput = Readonly<{
  beforeAdmissionWrite?: () => void;
  completionReservation?: CompletionRequestCallOptions["reservation"];
  completionService: CompletionAdmissionService;
  verifierRegistry: VerifierRegistry.Registry;
  requestId: string;
  workItemHash: string;
  result: Execution.Result;
  sourceOrigin: WorkItem.CompletionSourceOrigin;
  criterionFacts: readonly WorkerCriterionFactInput[];
  completionReport: WorkItem.CompletionReport;
  readBackEvidenceBindings: ReadonlyMap<number, WorkerReadBackEvidenceBinding>;
  now: () => number;
}>;

async function admitWorkerCompletion(
  input: WorkerCompletionAdmissionInput,
): Promise<CompletionBoundaryOutcome> {
  const item = requireWorkerCompletionIdentity(input.workItemHash, input.result);
  const requestId = workerCompletionRequestId(item, input.result);
  if (requestId !== input.requestId) {
    throw new Error(
      `completion request attempt changed: expected ${input.requestId}, received ${requestId}`,
    );
  }
  // Pin fact timestamps to the request's first durable reservation so a
  // re-projected replay hashes to the durable admission's requestRoot.
  const createdAt =
    item.completionFacts.requestReservations.find(
      (reservation) => reservation.requestId === requestId,
    )?.createdAt ?? input.now();
  const projected = projectCriterionFacts(
    input.verifierRegistry,
    item,
    requestId,
    input.criterionFacts,
    input.readBackEvidenceBindings,
    createdAt,
  );
  const request = WorkItem.CompletionRequest.parse({
    version: 1,
    id: requestId,
    origin: WorkItem.projectCompletionOrigin(input.sourceOrigin),
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
  return input.completionService.requestCompletion(request, input.completionReport, {
    ...(input.completionReservation === undefined
      ? {}
      : { reservation: input.completionReservation }),
    ...(input.beforeAdmissionWrite === undefined
      ? {}
      : { beforeAdmissionWrite: input.beforeAdmissionWrite }),
    verificationErrorAuthorityPort: projected.verificationErrorAuthorityPort,
  });
}

function assertDurableSourceIdentity(
  item: WorkItem.Info,
  requestId: string,
  sourceOrigin: WorkItem.CompletionSourceOrigin,
  result: Execution.Result,
): void {
  const admission = item.completionFacts.admissions.find(
    (candidate) => candidate.requestId === requestId,
  );
  if (!admission) return;
  const identity = workerCompletionSourceIdentity(sourceOrigin, result);
  if (!equal(admission.sourceIdentity ?? null, identity ?? null)) {
    throw new CompletionAdmissionError(
      "request_conflict",
      `completion request conflicts with durable source identity: ${admission.requestId}`,
    );
  }
}

function workerCompletionSourceIdentity(
  sourceOrigin: WorkItem.CompletionSourceOrigin,
  result: Execution.Result,
): WorkItem.CompletionSourceIdentity | undefined {
  if (
    sourceOrigin.source === "internal_worker" ||
    sourceOrigin.source === "connector_worker" ||
    sourceOrigin.source === "replay" ||
    sourceOrigin.source === "recovery"
  ) {
    return WorkItem.CompletionSourceIdentity.parse({
      source: sourceOrigin.source,
      identity: {
        kind: "worker",
        id: `${result.sessionId}:${result.runId}`,
      },
    });
  }
  return WorkItem.projectCompletionSourceIdentity(sourceOrigin);
}

export function workerCompletionRequestId(item: WorkItem.Info, result: Execution.Result): string {
  return workerCompletionRequestRoot(item, result);
}

export function workerCompletionRequestRoot(item: WorkItem.Info, result: Execution.Result): string {
  return `completion-request:${item.hash}:${result.runId}:${result.sessionId}:attempt:${item.attempt}`;
}

export function workerCompletionReservationRoot(
  item: WorkItem.Info,
  result: Execution.Result,
  sourceOrigin: WorkItem.CompletionSourceOrigin | undefined,
): string {
  const sourceIdentity =
    sourceOrigin === undefined ? undefined : workerCompletionSourceIdentity(sourceOrigin, result);
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify(sourceIdentity ?? null))
    .digest("hex");
  return `${workerCompletionRequestRoot(item, result)}:source:${sourceDigest}`;
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

type ProjectedFacts = Readonly<{
  claims: readonly WorkItem.Claim[];
  observations: readonly WorkItem.Observation[];
  results: readonly WorkItem.CriterionResult[];
  verificationErrors: readonly WorkItem.VerificationErrorFact[];
  verificationErrorAuthorityPort: CompletionVerificationErrorAuthorityPort;
}>;

function projectCriterionFacts(
  registry: VerifierRegistry.Registry,
  item: WorkItem.Info,
  requestId: string,
  inputs: readonly WorkerCriterionFactInput[],
  readBackEvidenceBindings: ReadonlyMap<number, WorkerReadBackEvidenceBinding>,
  createdAt: number,
): ProjectedFacts {
  const claims: WorkItem.Claim[] = [];
  const observations: WorkItem.Observation[] = [];
  const results: WorkItem.CriterionResult[] = [];
  const verificationErrors: WorkItem.VerificationErrorFact[] = [];
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
    const recordedInputs = recordedInputsFromDurableEvidence(item, criterion, input, evidence);
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
  }

  return {
    claims,
    observations,
    results,
    verificationErrors,
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

function recordedInputsFromDurableEvidence(
  item: WorkItem.Info,
  criterion: WorkItem.Criterion,
  input: WorkerCriterionFactInput,
  evidence: WorkItem.Evidence,
): Record<string, VerifierRegistry.JsonValue> {
  const verifierInput = durableVerifierInput(item, criterion, evidence);
  if (!verifierInput) {
    throw new Error(`verifier evidence does not match criterion: ${evidence.id}`);
  }
  if (verifierInput.kind !== input.verification.kind) {
    throw new Error(
      evidence.readBack !== undefined
        ? `verifier evidence does not match read-back kind: ${evidence.id}`
        : `verifier evidence does not match criterion: ${evidence.id}`,
    );
  }
  if (
    evidence.readBack !== undefined &&
    (!evidence.readBack.passed || evidence.readBack.matchedText === undefined)
  ) {
    throw new Error(`read-back verifier evidence did not pass: ${evidence.id}`);
  }
  return verifierInput.recordedInputs;
}

function requiredCheckedPredicate(verification: VerifierRegistry.VerificationResult): string {
  if (verification.checkedPredicate === undefined) {
    throw new Error(
      `decisive verifier result has no checked predicate: ${verification.obligationId}`,
    );
  }
  return verification.checkedPredicate;
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

function digestCompletionEnvelope(envelope: CompletionEnvelope): string {
  return createHash("sha256").update(canonicalEvidenceJson(envelope)).digest("hex");
}

async function completionOutcomeReflection(
  workItemHash: string,
  outcome: CompletionBoundaryOutcome,
): Promise<CompletionReflection> {
  if (outcome.completed) return completionReflection(workItemHash, false);
  return blockCompletion(
    workItemHash,
    completionBlockerDescription(outcome.admission) ?? "completion admission blocked",
  );
}

function parseCompletionEnvelope(result: Execution.Result): ParsedCompletionEnvelope {
  if (!result.output) return { ok: false, reason: "completion report is required" };
  const parsedJson = parseJson(result.output);
  if (!parsedJson.ok) return { ok: false, reason: "completion report is required" };
  const parsed = CompletionEnvelope.safeParse(parsedJson.value);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".");
  const detail = field && issue ? `${field}: ${issue.message}` : issue?.message;
  return { ok: false, reason: `completion report is invalid: ${detail}` };
}

function parseJson(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

type PreparedCompletionReport = Readonly<{
  report: WorkItem.CompletionReport;
  readBackEvidenceBindings: ReadonlyMap<number, WorkerReadBackEvidenceBinding>;
}>;

/**
 * Rebuilds the admitted-replay report without touching the network or the
 * reservation lease: read-back evidence ids are deterministic per request
 * root, so the projection matches the durable admission snapshot.
 */
function replayPreparedReport(
  requestRoot: string,
  envelope: CompletionEnvelope,
): PreparedCompletionReport {
  const evidenceIdsByClaim = new Map<number, string[]>();
  const readBackEvidenceBindings = new Map<number, WorkerReadBackEvidenceBinding>();
  for (const [requestIndex, readBack] of envelope.readBackRequests.entries()) {
    const evidenceId = readBackEvidenceId(requestRoot, requestIndex);
    const existing = evidenceIdsByClaim.get(readBack.claimIndex) ?? [];
    evidenceIdsByClaim.set(readBack.claimIndex, [...existing, evidenceId]);
    readBackEvidenceBindings.set(requestIndex, {
      evidenceId,
      criterionIndex: readBack.criterionIndex,
    });
  }
  return {
    report: WorkItem.CompletionReport.parse({
      ...envelope.completionReport,
      claims: attachReadBackEvidence(envelope.completionReport, evidenceIdsByClaim),
    }),
    readBackEvidenceBindings,
  };
}

async function prepareCompletionReport(
  workItemHash: string,
  requestRoot: string,
  envelope: CompletionEnvelope,
  options: WorkerCompletionOptions,
  assertLease: () => void,
): Promise<PreparedCompletionReport> {
  if (envelope.readBackRequests.length === 0) {
    return {
      report: WorkItem.CompletionReport.parse(envelope.completionReport),
      readBackEvidenceBindings: new Map(),
    };
  }

  const item = WorkItemStore.get(workItemHash);
  if (!item) throw new Error(`WorkItem not found: ${workItemHash}`);
  const evidenceIdsByClaim = new Map<number, string[]>();
  const readBackEvidenceBindings = new Map<number, WorkerReadBackEvidenceBinding>();
  const now = options.now ?? Date.now;
  const executeReadBack =
    options.readBackRecorder ??
    ((_workItemHash, input, readBackOptions) => ReadBackExecutor.execute(input, readBackOptions));
  const deadlineAt = now() + resolveReadBackEnvelopeTimeoutMs(options);
  for (const [requestIndex, readBack] of envelope.readBackRequests.entries()) {
    assertLease();
    const criterionId = item.completionFacts.criteria[readBack.criterionIndex]?.id;
    if (!criterionId) {
      throw new Error(`read-back completion criterion is unknown: ${readBack.criterionIndex}`);
    }
    const evidenceId = readBackEvidenceId(requestRoot, requestIndex);
    const existingEvidence = WorkItemStore.get(workItemHash)?.evidence.find(
      ({ id }) => id === evidenceId,
    );
    if (existingEvidence) {
      if (
        existingEvidence.attempt !== item.attempt ||
        existingEvidence.basisRef !== item.completionContract.basisRef ||
        existingEvidence.criterionId !== criterionId ||
        existingEvidence.readBack === undefined
      ) {
        throw new Error(`read-back evidence identity conflict: ${evidenceId}`);
      }
      const existing = evidenceIdsByClaim.get(readBack.claimIndex) ?? [];
      evidenceIdsByClaim.set(readBack.claimIndex, [...existing, evidenceId]);
      readBackEvidenceBindings.set(requestIndex, {
        evidenceId,
        criterionIndex: readBack.criterionIndex,
      });
      continue;
    }
    const remainingMs = deadlineAt - now();
    if (remainingMs <= 0) throw new Error("read-back envelope deadline exceeded");
    const check = await settleReadBackBeforeDeadline(
      Promise.resolve(
        executeReadBack(
          workItemHash,
          applySharedDeadline(readBack.request, remainingMs),
          options.readBack,
        ),
      ),
      deadlineAt,
      now,
    );
    assertLease();
    const updated = await WorkItemStore.addReadBackEvidence(workItemHash, check, {
      expectedAttempt: item.attempt,
      expectedBasisRef: item.completionContract.basisRef,
      criterionId,
      evidenceId,
    });
    assertLease();
    if (!updated?.evidence.some(({ id }) => id === evidenceId)) {
      throw new Error("read-back evidence was not recorded");
    }
    const existing = evidenceIdsByClaim.get(readBack.claimIndex) ?? [];
    evidenceIdsByClaim.set(readBack.claimIndex, [...existing, evidenceId]);
    readBackEvidenceBindings.set(requestIndex, {
      evidenceId,
      criterionIndex: readBack.criterionIndex,
    });
  }
  // A deadline that expires while the final evidence persist settles must
  // still block this attempt: the evidence is durable, so a retry completes.
  if (now() >= deadlineAt) throw new Error("read-back envelope deadline exceeded");

  return {
    report: WorkItem.CompletionReport.parse({
      ...envelope.completionReport,
      claims: attachReadBackEvidence(envelope.completionReport, evidenceIdsByClaim),
    }),
    readBackEvidenceBindings,
  };
}

function readBackEvidenceId(requestRoot: string, requestIndex: number): string {
  return `evidence:read-back:${createHash("sha256")
    .update(`${requestRoot}:${requestIndex}`)
    .digest("hex")}`;
}

function attachReadBackEvidence(
  report: CompletionReportDraft,
  evidenceIdsByClaim: ReadonlyMap<number, readonly string[]>,
): WorkItem.CompletionReport["claims"] {
  return report.claims.map((claim, index) => {
    const claimReadBackEvidence = evidenceIdsByClaim.get(index);
    if (!claimReadBackEvidence) return claim;
    return {
      ...claim,
      evidenceIds: [...claim.evidenceIds, ...claimReadBackEvidence],
    };
  });
}

function resolveReadBackEnvelopeTimeoutMs(options: WorkerCompletionOptions): number {
  const configured = options.readBackEnvelopeTimeoutMs;
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return MAX_READ_BACK_TIMEOUT_MS;
  }
  return Math.min(Math.ceil(configured), MAX_READ_BACK_TIMEOUT_MS);
}

async function settleReadBackBeforeDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
  now: () => number,
): Promise<T> {
  let settled: T | undefined;
  try {
    settled = await settleBeforeDeadline(operation, deadlineAt, now);
  } catch (error) {
    if (now() >= deadlineAt) throw new Error("read-back envelope deadline exceeded");
    throw error;
  }
  if (settled === undefined) throw new Error("read-back envelope deadline exceeded");
  return settled;
}

function applySharedDeadline(request: ReadBackRequest, remainingMs: number): ReadBackRequest {
  const timeoutMs = Math.max(
    1,
    Math.min(request.timeoutMs ?? MAX_READ_BACK_TIMEOUT_MS, Math.floor(remainingMs)),
  );
  switch (request.kind) {
    case "url_fetch":
      return { ...request, timeoutMs };
    case "api_query":
      return { ...request, timeoutMs };
    case "citation_match":
      return { ...request, timeoutMs };
  }
}

async function blockCompletion(
  workItemHash: string,
  description: string,
): Promise<CompletionReflection> {
  const current = WorkItemStore.get(workItemHash);
  const currentStatus = current ? WorkItem.deriveStatus(current) : undefined;
  if (
    currentStatus === "failed" ||
    currentStatus === "cancelled" ||
    currentStatus === "completed"
  ) {
    return completionReflection(workItemHash, true, description);
  }
  if (
    current?.blockers.some(
      (blocker) => blocker.resolvedAt === undefined && blocker.description === description,
    )
  ) {
    return completionReflection(workItemHash, true, description);
  }
  await WorkItemStore.addBlocker(workItemHash, {
    kind: "error",
    description,
  });
  return completionReflection(workItemHash, true, description);
}

function completionReflection(
  workItemHash: string,
  completionBlocked: boolean,
  completionBlocker?: string,
): CompletionReflection {
  const workItem = WorkItemStore.get(workItemHash);
  return {
    ...(workItem ? { workItemStatus: WorkItem.deriveStatus(workItem) } : {}),
    completionBlocked,
    ...(completionBlocker ? { completionBlocker } : {}),
  };
}
