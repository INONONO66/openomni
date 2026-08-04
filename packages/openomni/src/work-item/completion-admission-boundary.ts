import { WorkItem } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";
import type { CompletionAuthorityResolver } from "./completion-admission-authority.js";
import {
  completionReportReference,
  completionReportsMatch,
  canonicalCompletionRequest,
  completionRequestsMatch,
} from "./completion-request-identity.js";

export type CompletionAdmissionServiceErrorCode =
  | "invalid_subject"
  | "stale_basis"
  | "stale_head"
  | "admission_required"
  | "request_conflict"
  | "terminal_state"
  | "unsupported_fact";

export class CompletionAdmissionServiceError extends Error {
  readonly name = "CompletionAdmissionServiceError";

  constructor(
    readonly code: CompletionAdmissionServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type CompletionBoundaryOutcome = Readonly<{
  admission: WorkItem.CompletionAdmission;
  workItem: WorkItem.Info;
  completed: boolean;
}>;

export type CompletionAdmissionServiceOptions = Readonly<{
  authorityResolver: CompletionAuthorityResolver;
  now: () => number;
}>;

export type CompletionAdmissionService = Readonly<{
  requestCompletion(
    request: WorkItem.CompletionRequest,
    completionReport: WorkItem.CompletionReport,
  ): Promise<CompletionBoundaryOutcome>;
  resumeCompletion(
    workItemHash: string,
    admissionId: string,
    completionReport: WorkItem.CompletionReport,
  ): Promise<WorkItem.Info>;
}>;

export function createCompletionAdmissionService(
  options: CompletionAdmissionServiceOptions,
): CompletionAdmissionService {
  return Object.freeze({
    async requestCompletion(requestInput, completionReportInput) {
      const request = WorkItem.CompletionRequest.parse(requestInput);
      assertRequesterFactsSupported(request);
      const completionReport = WorkItem.CompletionReport.parse(completionReportInput);
      const adapter = requiredAdapter(request.workItemHash);
      const initial = requiredItem(adapter.get(request.workItemHash), request.workItemHash);
      assertNotFailedOrCancelled(initial);
      const priorAdmissions = initial.completionFacts.admissions.filter(
        ({ requestId }) => requestId === request.id,
      );
      if (priorAdmissions.length > 0) {
        return replayRequest(initial, request, completionReport, priorAdmissions, options);
      }
      assertNotCompleted(initial);
      assertInitialRequest(initial, request);
      publishRequested(request, initial.sessionId, options.now());

      const admission = canonicalAdmission(
        await options.authorityResolver.resolve(initial, request),
        completionReport,
      );
      assertAdmissionMatches(admission, initial, request);
      assertUnchangedAfterAuthority(adapter, initial);
      const recorded = await appendAdmission(adapter, initial, request, admission);
      if (!isAdmitted(admission)) {
        return { admission, workItem: recorded, completed: false };
      }

      return completeOrReevaluate(adapter, recorded, request, completionReport, admission, options);
    },

    async resumeCompletion(workItemHash, admissionId, completionReportInput) {
      const completionReport = WorkItem.CompletionReport.parse(completionReportInput);
      const adapter = requiredAdapter(workItemHash);
      const item = requiredItem(adapter.get(workItemHash), workItemHash);
      assertNotFailedOrCancelled(item);
      const admission = item.completionFacts.admissions.find(({ id }) => id === admissionId);
      if (!admission || !isAdmitted(admission)) {
        throw admissionRequired(workItemHash, admissionId);
      }
      assertAdmissionReportMatches(admission, completionReport);
      if (WorkItem.deriveStatus(item) === "completed") {
        if (item.completionTerminalReceipt?.admissionId === admissionId) return item;
        throw admissionRequired(workItemHash, admissionId);
      }
      if (
        admission.contractRevision !== item.completionContract.revision ||
        admission.basisRef !== item.completionContract.basisRef
      ) {
        throw new CompletionAdmissionServiceError(
          "stale_basis",
          `completion admission basis is stale for ${workItemHash}`,
        );
      }
      if (item.revision === admission.recordedHead) {
        return commitTerminal(adapter, item, admission, completionReport, options.now());
      }

      const request = requestFromAdmission(item, admission);
      const nextAdmission = canonicalAdmission(
        await options.authorityResolver.resolve(item, request),
        completionReport,
      );
      assertAdmissionMatches(nextAdmission, item, request);
      assertUnchangedAfterAuthority(adapter, item);
      const recorded = await appendAdmission(adapter, item, request, nextAdmission);
      if (!isAdmitted(nextAdmission)) return recorded;
      return commitTerminal(adapter, recorded, nextAdmission, completionReport, options.now());
    },
  });
}

async function replayRequest(
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  completionReport: WorkItem.CompletionReport,
  admissions: readonly WorkItem.CompletionAdmission[],
  options: CompletionAdmissionServiceOptions,
): Promise<CompletionBoundaryOutcome> {
  assertReplayMatches(request, admissions);
  const original = admissions[0];
  if (!original) throw requestConflict(request.id);
  assertAdmissionReportMatches(original, completionReport);
  const receipt = item.completionTerminalReceipt;
  if (WorkItem.deriveStatus(item) === "completed") {
    if (JSON.stringify(item.completionReport) !== JSON.stringify(completionReport)) {
      throw requestConflict(request.id);
    }
    const admission = admissions.find(({ id }) => id === receipt?.admissionId);
    if (!admission) throw admissionRequired(item.hash, receipt?.admissionId ?? "missing");
    return { admission, workItem: item, completed: true };
  }
  const admission = admissions.at(-1);
  if (!admission) throw requestConflict(request.id);
  if (!isAdmitted(admission)) return { admission, workItem: item, completed: false };
  if (item.revision === admission.recordedHead) {
    const completed = commitTerminal(
      requiredAdapter(item.hash),
      item,
      admission,
      completionReport,
      options.now(),
    );
    return { admission, workItem: completed, completed: true };
  }
  return completeOrReevaluate(
    requiredAdapter(item.hash),
    item,
    request,
    completionReport,
    admission,
    options,
  );
}

async function completeOrReevaluate(
  adapter: NonNullable<ReturnType<typeof Storage.get>["workItem"]>,
  recorded: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  completionReport: WorkItem.CompletionReport,
  admission: WorkItem.CompletionAdmission,
  options: CompletionAdmissionServiceOptions,
): Promise<CompletionBoundaryOutcome> {
  const latest = requiredItem(adapter.get(recorded.hash), recorded.hash);
  assertNotFailedOrCancelled(latest);
  if (latest.revision === admission.recordedHead) {
    const completed = commitTerminal(adapter, latest, admission, completionReport, options.now());
    return { admission, workItem: completed, completed: true };
  }
  assertSameBasis(latest, admission);

  const recheck = requestAtHead(request, latest.revision);
  const nextAdmission = canonicalAdmission(
    await options.authorityResolver.resolve(latest, recheck),
    completionReport,
  );
  assertAdmissionMatches(nextAdmission, latest, recheck);
  assertUnchangedAfterAuthority(adapter, latest);
  const nextRecorded = await appendAdmission(adapter, latest, recheck, nextAdmission);
  if (!isAdmitted(nextAdmission)) {
    return { admission: nextAdmission, workItem: nextRecorded, completed: false };
  }
  const beforeTerminal = requiredItem(adapter.get(latest.hash), latest.hash);
  if (beforeTerminal.revision !== nextAdmission.recordedHead) {
    throw new CompletionAdmissionServiceError(
      "stale_head",
      `WorkItem changed again while completing: ${latest.hash}`,
    );
  }
  const completed = commitTerminal(
    adapter,
    beforeTerminal,
    nextAdmission,
    completionReport,
    options.now(),
  );
  return { admission: nextAdmission, workItem: completed, completed: true };
}

async function appendAdmission(
  adapter: NonNullable<ReturnType<typeof Storage.get>["workItem"]>,
  existing: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  admissionInput: WorkItem.CompletionAdmission,
): Promise<WorkItem.Info> {
  const admission = WorkItem.CompletionAdmission.parse(admissionInput);
  const conflictingAdmission = existing.completionFacts.admissions.find(
    ({ id }) => id === admission.id,
  );
  if (conflictingAdmission) throw requestConflict(request.id);
  const updated = WorkItem.Info.parse({
    ...existing,
    revision: admission.recordedHead,
    completionFacts: {
      ...existing.completionFacts,
      revision: existing.completionFacts.revision + 1,
      claims: appendFacts(existing.completionFacts.claims, request.claims, WorkItem.Claim),
      observations: appendFacts(
        existing.completionFacts.observations,
        request.observations,
        WorkItem.Observation,
      ),
      results: appendFacts(
        existing.completionFacts.results,
        request.results,
        WorkItem.CriterionResult,
      ),
      invalidations: appendFacts(
        existing.completionFacts.invalidations,
        request.invalidations,
        WorkItem.ResultInvalidation,
      ),
      verificationErrors: appendFacts(
        existing.completionFacts.verificationErrors,
        request.verificationErrors,
        WorkItem.VerificationErrorFact,
      ),
      effects: appendFacts(
        existing.completionFacts.effects,
        request.effects,
        WorkItem.EffectRecord,
      ),
      admissions: [...existing.completionFacts.admissions, admission],
    },
    timestamps: { ...existing.timestamps, updated: admission.createdAt },
  });
  if (!adapter.compareAndSet(existing.hash, existing.revision, updated)) {
    throw new CompletionAdmissionServiceError(
      "stale_head",
      `WorkItem changed while recording completion admission: ${existing.hash}`,
    );
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
  adapter: NonNullable<ReturnType<typeof Storage.get>["workItem"]>,
  existing: WorkItem.Info,
  admission: WorkItem.CompletionAdmission,
  completionReport: WorkItem.CompletionReport,
  time: number,
): WorkItem.Info {
  const current = requiredItem(adapter.get(existing.hash), existing.hash);
  assertNotFailedOrCancelled(current);
  assertTerminalEligibleAdmission(admission);
  if (current.revision !== existing.revision || current.revision !== admission.recordedHead) {
    throw new CompletionAdmissionServiceError(
      "stale_head",
      `WorkItem changed before terminal completion: ${existing.hash}`,
    );
  }
  assertSameBasis(current, admission);
  const report = verifyCompletionReport(current, completionReport);
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
  if (!adapter.compareAndSet(current.hash, current.revision, completed)) {
    throw new CompletionAdmissionServiceError(
      "stale_head",
      `WorkItem changed during terminal completion: ${current.hash}`,
    );
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

function assertInitialRequest(item: WorkItem.Info, request: WorkItem.CompletionRequest): void {
  if (request.workItemHash !== item.hash) {
    throw new CompletionAdmissionServiceError(
      "invalid_subject",
      `completion request subject ${request.workItemHash} does not match ${item.hash}`,
    );
  }
  if (request.expectedHead !== item.revision) {
    throw new CompletionAdmissionServiceError(
      "stale_head",
      `completion request head ${request.expectedHead} does not match ${item.revision}`,
    );
  }
  if (
    request.contractRevision !== item.completionContract.revision ||
    request.basisRef !== item.completionContract.basisRef
  ) {
    throw new CompletionAdmissionServiceError(
      "stale_basis",
      `completion request basis is stale for ${item.hash}`,
    );
  }
}

function assertAdmissionMatches(
  admission: WorkItem.CompletionAdmission,
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
): void {
  if (
    admission.requestId !== request.id ||
    !completionRequestsMatch(admission.requestSnapshot, request) ||
    admission.origin !== request.origin ||
    admission.contractRevision !== item.completionContract.revision ||
    admission.basisRef !== item.completionContract.basisRef
  ) {
    throw requestConflict(request.id);
  }
  if (admission.expectedHead !== item.revision || admission.recordedHead !== item.revision + 1) {
    throw new CompletionAdmissionServiceError(
      "stale_head",
      `completion admission head does not match ${item.revision}`,
    );
  }
  if (
    admission.decision === "owner_override" &&
    admission.ownerOverrideReceiptRef !== request.ownerOverrideReceiptRef
  ) {
    throw requestConflict(request.id);
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
    original.expectedHead !== request.expectedHead ||
    !completionRequestsMatch(original.requestSnapshot, request)
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
  completionReport: WorkItem.CompletionReport,
): WorkItem.CompletionReport {
  const report = WorkItem.CompletionReport.parse(completionReport);
  const evidenceById = new Map(item.evidence.map((evidence) => [evidence.id, evidence]));
  const missing = report.claims.flatMap((claim) =>
    claim.evidenceIds.filter((evidenceId) => !evidenceById.has(evidenceId)),
  );
  if (missing.length > 0) {
    throw new Error(`completion report references missing evidence: ${missing.join(", ")}`);
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

function requestAtHead(
  request: WorkItem.CompletionRequest,
  expectedHead: number,
): WorkItem.CompletionRequest {
  return WorkItem.CompletionRequest.parse({
    ...request,
    expectedHead,
    claims: [],
    observations: [],
    results: [],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  });
}

function requestFromAdmission(
  item: WorkItem.Info,
  admission: WorkItem.CompletionAdmission,
): WorkItem.CompletionRequest {
  return WorkItem.CompletionRequest.parse({
    version: 1,
    id: admission.requestId,
    origin: admission.origin,
    workItemHash: item.hash,
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    expectedHead: item.revision,
    ...(admission.requestSnapshot.ownerOverrideReceiptRef
      ? { ownerOverrideReceiptRef: admission.requestSnapshot.ownerOverrideReceiptRef }
      : {}),
    claims: [],
    observations: [],
    results: [],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  });
}

function assertUnchangedAfterAuthority(
  adapter: NonNullable<ReturnType<typeof Storage.get>["workItem"]>,
  expected: WorkItem.Info,
): void {
  const current = requiredItem(adapter.get(expected.hash), expected.hash);
  assertNotFailedOrCancelled(current);
  if (current.revision !== expected.revision) {
    throw new CompletionAdmissionServiceError(
      "stale_head",
      `WorkItem changed while resolving completion authority: ${expected.hash}`,
    );
  }
}

function assertNotFailedOrCancelled(item: WorkItem.Info): void {
  const status = WorkItem.deriveStatus(item);
  if (status !== "failed" && status !== "cancelled") return;
  throw new CompletionAdmissionServiceError(
    "terminal_state",
    `Cannot complete a ${status} WorkItem: ${item.hash}`,
  );
}

function assertNotCompleted(item: WorkItem.Info): void {
  if (WorkItem.deriveStatus(item) !== "completed") return;
  throw new CompletionAdmissionServiceError(
    "terminal_state",
    `Cannot start a new completion request for completed WorkItem: ${item.hash}`,
  );
}

function assertSameBasis(item: WorkItem.Info, admission: WorkItem.CompletionAdmission): void {
  if (
    admission.contractRevision !== item.completionContract.revision ||
    admission.basisRef !== item.completionContract.basisRef
  ) {
    throw new CompletionAdmissionServiceError(
      "stale_basis",
      `completion admission basis is stale for ${item.hash}`,
    );
  }
}

function canonicalAdmission(
  input: WorkItem.CompletionAdmission,
  completionReport: WorkItem.CompletionReport,
): WorkItem.CompletionAdmission {
  assertTerminalEligibleAdmission(input);
  const admission = WorkItem.CompletionAdmission.parse(input);
  const completionReportSnapshot = WorkItem.CompletionReport.parse(completionReport);
  const completionReportRef = completionReportReference(completionReportSnapshot);
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
    requestSnapshot: canonicalCompletionRequest(admission.requestSnapshot),
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
    reference !== completionReportReference(snapshot) ||
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

function assertRequesterFactsSupported(request: WorkItem.CompletionRequest): void {
  if (request.invalidations.length === 0 && request.effects.length === 0) return;
  throw new CompletionAdmissionServiceError(
    "unsupported_fact",
    "completion requests cannot propose invalidations or effects without trusted authority",
  );
}

function assertTerminalEligibleAdmission(admission: WorkItem.CompletionAdmission): void {
  if (admission.decision === "admit" && admission.unresolvedCriterionIds.length > 0) {
    throw new CompletionAdmissionServiceError(
      "admission_required",
      `admit cannot carry unresolved required criteria: ${admission.id}`,
    );
  }
  if (
    admission.decision === "owner_override" &&
    (!admission.ownerOverrideReceiptRef ||
      admission.ownerOverrideReceiptRef !== admission.requestSnapshot.ownerOverrideReceiptRef)
  ) {
    throw new CompletionAdmissionServiceError(
      "admission_required",
      `owner_override requires its request-bound receipt: ${admission.id}`,
    );
  }
}

function isAdmitted(admission: WorkItem.CompletionAdmission): boolean {
  return admission.decision === "admit" || admission.decision === "owner_override";
}

function requiredAdapter(hash: string): NonNullable<ReturnType<typeof Storage.get>["workItem"]> {
  const adapter = Storage.get().workItem;
  if (!adapter) {
    throw new CompletionAdmissionServiceError(
      "invalid_subject",
      `WorkItem storage is unavailable: ${hash}`,
    );
  }
  return adapter;
}

function requiredItem(item: WorkItem.Info | undefined, hash: string): WorkItem.Info {
  if (!item) {
    throw new CompletionAdmissionServiceError(
      "invalid_subject",
      `WorkItem does not exist: ${hash}`,
    );
  }
  return item;
}

function admissionRequired(hash: string, admissionId: string): CompletionAdmissionServiceError {
  return new CompletionAdmissionServiceError(
    "admission_required",
    `matching admitted completion record is required: ${hash}:${admissionId}`,
  );
}

function requestConflict(requestId: string): CompletionAdmissionServiceError {
  return new CompletionAdmissionServiceError(
    "request_conflict",
    `completion request conflicts with durable facts: ${requestId}`,
  );
}
