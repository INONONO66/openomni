import type { PolicyEngine } from "@openomni/policy";
import { WorkItem, type Execution } from "@openomni/protocol";
import { type Storage, WorkItemStore } from "@openomni/session";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ReadBackExecutor } from "../../evidence/read-back-executor.js";
import { canonicalJson as canonicalEvidenceJson } from "../../evidence/verifier-conformance-canonical.js";
import type { CompletionStakesResolver } from "../../work-item/completion-admission-authority.js";
import {
  assertCompletionReservationLease,
  type CompletionBoundaryOutcome,
  CompletionAdmissionServiceError,
  reserveCompletionRequest,
} from "../../work-item/completion-admission-boundary.js";
import { CompletionSourceOrigin } from "../../work-item/completion-origin.js";
import {
  admitWorkerCompletion,
  replayWorkerCompletion,
  requireWorkerCompletionIdentity,
  WorkerCriterionFactInput,
  workerCompletionRequestId,
  workerCompletionReservationRoot,
  workerCompletionRequestRoot,
  type WorkerReadBackEvidenceBinding,
} from "./worker-completion-admission.js";

const MAX_READ_BACK_REQUESTS = 5;
const MAX_READ_BACK_TIMEOUT_MS = 10_000;
const MAX_READ_BACK_BODY_BYTES = 1_000_000;
const activeCompletionRequests = new Map<string, string>();
const completionReservationOwnerId = `completion-process:${crypto.randomUUID()}`;

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

export type CompletionPolicyEngine = ReturnType<typeof PolicyEngine.create>;

export interface WorkerCompletionOptions {
  readonly completionReservationOwnerId?: string;
  readonly completionWriter?: Storage.WorkItemCompletionWriter;
  readonly sourceOrigin: CompletionSourceOrigin;
  readonly completionPolicyEngine: CompletionPolicyEngine;
  readonly stakesResolver?: CompletionStakesResolver;
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
  let sourceOrigin: CompletionSourceOrigin;
  try {
    sourceOrigin = CompletionSourceOrigin.parse(options.sourceOrigin);
    item = requireWorkerCompletionIdentity(workItemHash, result);
  } catch (error) {
    return completionReflection(
      workItemHash,
      true,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (result.status === "succeeded") {
    if (!options.completionWriter) {
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
      const replay = await replayWorkerCompletion({
        completionWriter: options.completionWriter,
        workItemHash,
        result,
        sourceOrigin,
        completionEnvelopeDigest,
        policyEngine: options.completionPolicyEngine,
        completionReportMatches: (report) =>
          completionReportDraftMatches(requestRoot, parsed.envelope, report),
        ...(options.stakesResolver === undefined ? {} : { stakesResolver: options.stakesResolver }),
        now,
      });
      if (replay) return completionOutcomeReflection(workItemHash, replay);
      const requestId = workerCompletionRequestId(item, result);
      const reservationOwnerId =
        options.completionReservationOwnerId ?? completionReservationOwnerId;
      const reservation = reserveCompletionRequest({
        completionWriter: options.completionWriter,
        workItemHash,
        requestId,
        requestRoot: reservationRoot,
        envelopeDigest: completionEnvelopeDigest,
        ownerId: reservationOwnerId,
        leaseDurationMs: resolveReadBackEnvelopeTimeoutMs(options) + 5_000,
        now: now(),
      });
      const assertLease = () =>
        assertCompletionReservationLease({
          workItemHash,
          requestId,
          reservationId: reservation.reservation.id,
          ownerId: reservationOwnerId,
          fence: reservation.reservation.fence,
          now: now(),
        });
      if (
        reservation.state === "busy" ||
        (reservation.state === "existing" && activeCompletionRequests.has(requestId))
      ) {
        return completionReflection(
          workItemHash,
          true,
          `completion request is already in progress: ${requestId}`,
        );
      }
      const completionReservation = {
        ownerId: reservationOwnerId,
        leaseDurationMs: resolveReadBackEnvelopeTimeoutMs(options) + 5_000,
        requestRoot: reservationRoot,
        envelopeDigest: completionEnvelopeDigest,
      };
      const invocationToken = reservation.reservation.id;
      activeCompletionRequests.set(requestId, invocationToken);
      try {
        const admittedReplay = await replayWorkerCompletion({
          beforeAdmissionWrite: assertLease,
          completionReservation,
          completionWriter: options.completionWriter,
          workItemHash,
          result,
          sourceOrigin,
          completionEnvelopeDigest,
          policyEngine: options.completionPolicyEngine,
          completionReportMatches: (report) =>
            completionReportDraftMatches(requestRoot, parsed.envelope, report),
          ...(options.stakesResolver === undefined
            ? {}
            : { stakesResolver: options.stakesResolver }),
          now,
        });
        if (admittedReplay) {
          return completionOutcomeReflection(workItemHash, admittedReplay);
        }
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
          completionWriter: options.completionWriter,
          requestId,
          workItemHash,
          result,
          completionEnvelopeDigest,
          sourceOrigin,
          criterionFacts: parsed.envelope.criterionFacts,
          completionReport: prepared.report,
          policyEngine: options.completionPolicyEngine,
          readBackEvidenceBindings: prepared.readBackEvidenceBindings,
          ...(options.stakesResolver === undefined
            ? {}
            : { stakesResolver: options.stakesResolver }),
          now,
        });
        return completionOutcomeReflection(workItemHash, outcome);
      } finally {
        if (activeCompletionRequests.get(requestId) === invocationToken) {
          activeCompletionRequests.delete(requestId);
        }
      }
    } catch (err) {
      if (
        err instanceof CompletionAdmissionServiceError &&
        (err.code === "stale_basis" ||
          (err.code === "request_conflict" &&
            err.message.startsWith("completion reservation lease lost:")))
      ) {
        return completionReflection(workItemHash, true, err.message);
      }
      if (
        err instanceof CompletionAdmissionServiceError &&
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
    `completion admission ${outcome.admission.decision}: ${outcome.admission.reasonCodes.join(", ")}`,
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
    const operation = executeReadBack(
      workItemHash,
      applySharedDeadline(readBack.request, remainingMs),
      options.readBack,
    );
    const operationPromise = Promise.resolve(operation);
    const remainingAfterStartMs = deadlineAt - now();
    if (remainingAfterStartMs <= 0) {
      void operationPromise.catch(() => undefined);
      throw new Error("read-back envelope deadline exceeded");
    }
    const check = await settleReadBackBeforeDeadline(operationPromise, remainingAfterStartMs);
    assertLease();
    if (deadlineAt - now() <= 0) throw new Error("read-back envelope deadline exceeded");
    const updated = await WorkItemStore.addReadBackEvidence(workItemHash, check, {
      expectedAttempt: item.attempt,
      expectedBasisRef: item.completionContract.basisRef,
      criterionId,
      evidenceId,
    });
    assertLease();
    if (deadlineAt - now() <= 0) throw new Error("read-back envelope deadline exceeded");
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

function completionReportDraftMatches(
  requestRoot: string,
  envelope: CompletionEnvelope,
  stored: WorkItem.CompletionReport,
): boolean {
  const draft = envelope.completionReport;
  if (
    draft.summary !== stored.summary ||
    JSON.stringify(draft.caveats) !== JSON.stringify(stored.caveats) ||
    JSON.stringify(draft.followUps) !== JSON.stringify(stored.followUps) ||
    draft.claims.length !== stored.claims.length
  ) {
    return false;
  }
  return draft.claims.every((claim, index) => {
    const storedClaim = stored.claims[index];
    if (!storedClaim || claim.statement !== storedClaim.statement) return false;
    const expectedEvidenceIds = new Set(claim.evidenceIds);
    for (let requestIndex = 0; requestIndex < envelope.readBackRequests.length; requestIndex += 1) {
      if (envelope.readBackRequests[requestIndex]?.claimIndex === index) {
        expectedEvidenceIds.add(readBackEvidenceId(requestRoot, requestIndex));
      }
    }
    const storedEvidenceIds = new Set(storedClaim.evidenceIds);
    return (
      storedEvidenceIds.size === expectedEvidenceIds.size &&
      [...expectedEvidenceIds].every((evidenceId) => storedEvidenceIds.has(evidenceId))
    );
  });
}

function resolveReadBackEnvelopeTimeoutMs(options: WorkerCompletionOptions): number {
  const configured = options.readBackEnvelopeTimeoutMs;
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return MAX_READ_BACK_TIMEOUT_MS;
  }
  return Math.min(Math.ceil(configured), MAX_READ_BACK_TIMEOUT_MS);
}

function settleReadBackBeforeDeadline<T>(operation: Promise<T>, remainingMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(
      () => finish(() => reject(new Error("read-back envelope deadline exceeded"))),
      remainingMs,
    );

    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      settle();
    }

    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
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
