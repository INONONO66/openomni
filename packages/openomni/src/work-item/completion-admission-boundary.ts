import { WorkItem } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";
import {
  CompletionAdmissionError,
  type CompletionAuthorityResolver,
} from "./completion-admission-authority.js";
import {
  canonicalCompletionRequest,
  completionReportReference,
  completionReportsMatch,
  completionRequestEnvelopeDigest,
  completionRequestRoot,
  completionRequestsMatch,
} from "./completion-request-identity.js";

export type CompletionAdmissionServiceErrorCode =
  | "invalid_subject"
  | "stale_basis"
  | "stale_head"
  | "authority_unavailable"
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
  completionWriter: Storage.WorkItemCompletionWriter;
  authorityResolver: CompletionAuthorityResolver;
  beforeAdmissionWrite?: () => void;
  allowTrustedInvalidations?: boolean;
  now: () => number;
  reservation?: CompletionReservationOptions;
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

export type CompletionRequestReservationInput = Readonly<{
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

export type CompletionReservationLeaseInput = Readonly<{
  workItemHash: string;
  requestId: string;
  reservationId: string;
  ownerId: string;
  fence: number;
  now: number;
}>;

export type CompletionReservationOptions = Readonly<{
  ownerId: string;
  leaseDurationMs: number;
  requestRoot?: string;
  envelopeDigest?: string;
}>;

type CompletionReservationAssertion = (() => void) &
  Readonly<{
    state: "reserved" | "existing";
    recordedHead: number;
  }>;

const CompletionCasRetryLimit = 8;

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
    if (
      reservation &&
      (reservation.requestRoot !== input.requestRoot ||
        reservation.envelopeDigest !== input.envelopeDigest)
    ) {
      throw requestConflict(input.requestId);
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
      throw new CompletionAdmissionServiceError(
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
  throw new CompletionAdmissionServiceError(
    "stale_head",
    `completion reservation contention did not converge: ${input.requestId}`,
  );
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
    throw new CompletionAdmissionServiceError(
      "request_conflict",
      `completion reservation lease lost: ${input.requestId}`,
    );
  }
}

export function createCompletionAdmissionService(
  options: CompletionAdmissionServiceOptions,
): CompletionAdmissionService {
  const reservation = options.reservation;
  return Object.freeze({
    async requestCompletion(requestInput, completionReportInput) {
      let request = WorkItem.CompletionRequest.parse(requestInput);
      assertRequesterFactsSupported(request, options.allowTrustedInvalidations === true);
      const completionReport = WorkItem.canonicalCompletionReport(
        WorkItem.CompletionReport.parse(completionReportInput),
      );
      const adapter = authorizedCompletionAdapter(
        requiredAdapter(request.workItemHash),
        options.completionWriter,
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
              return await replayRequest(
                initial,
                request,
                completionReport,
                priorAdmissions,
                options,
              );
            }
            const assertReservation =
              reservation === undefined
                ? undefined
                : reserveCompletionLease(initial, request, completionReport, reservation, options);
            return await replayRequest(
              initial,
              request,
              completionReport,
              priorAdmissions,
              options,
              assertReservation,
            );
          }
          assertNotCompleted(initial);
          assertInitialRequest(initial, request);
          const assertReservation =
            reservation === undefined
              ? undefined
              : reserveCompletionLease(initial, request, completionReport, reservation, options);
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
              throw new CompletionAdmissionServiceError(
                "stale_head",
                `WorkItem changed while reserving completion authority: ${reserved.hash}`,
              );
            }
          }
          if (!requestedPublished) {
            publishRequested(request, initial.sessionId, options.now());
            requestedPublished = true;
          }

          assertReservation?.();
          const authorityAdmission = await resolveAuthority(options, initial, request);
          const admission = canonicalAdmission(authorityAdmission, completionReport);
          assertUnchangedAfterAuthority(adapter, initial);
          assertAdmissionMatches(admission, initial, request);
          assertReservation?.();
          options.beforeAdmissionWrite?.();
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
            options,
            assertReservation,
          );
        } catch (error) {
          if (!(error instanceof CompletionAdmissionServiceError) || error.code !== "stale_head") {
            throw error;
          }
          const latest = requiredItem(adapter.get(request.workItemHash), request.workItemHash);
          if (
            latest.completionContract.revision !== request.contractRevision ||
            latest.completionContract.basisRef !== request.basisRef
          ) {
            throw new CompletionAdmissionServiceError(
              "stale_basis",
              `completion request basis is stale for ${latest.hash}`,
            );
          }
          request = rebaseCompletionRequestAtHead(request, latest.revision);
        }
      }
      throw new CompletionAdmissionServiceError(
        "stale_head",
        `completion admission contention did not converge: ${request.id}`,
      );
    },

    async resumeCompletion(workItemHash, admissionId, completionReportInput) {
      const completionReport = WorkItem.canonicalCompletionReport(
        WorkItem.CompletionReport.parse(completionReportInput),
      );
      const adapter = authorizedCompletionAdapter(
        requiredAdapter(workItemHash),
        options.completionWriter,
      );
      for (let attempt = 0; attempt < CompletionCasRetryLimit; attempt += 1) {
        try {
          return await resumeCompletionAtHead(
            adapter,
            workItemHash,
            admissionId,
            completionReport,
            reservation,
            options,
          );
        } catch (error) {
          if (!(error instanceof CompletionAdmissionServiceError) || error.code !== "stale_head") {
            throw error;
          }
        }
      }
      throw new CompletionAdmissionServiceError(
        "stale_head",
        `completion recovery contention did not converge: ${workItemHash}:${admissionId}`,
      );
    },
  });
}

function reserveCompletionLease(
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  completionReport: WorkItem.CompletionReport,
  reservation: CompletionReservationOptions,
  options: CompletionAdmissionServiceOptions,
  forceTakeover = false,
): CompletionReservationAssertion {
  const requestRoot = reservation.requestRoot ?? completionRequestRoot(request);
  const envelopeDigest =
    reservation.envelopeDigest ?? completionRequestEnvelopeDigest(request, completionReport);
  const acquired = reserveCompletionRequestWithLimit(
    {
      completionWriter: options.completionWriter,
      workItemHash: item.hash,
      requestId: request.id,
      requestRoot,
      envelopeDigest,
      ownerId: reservation.ownerId,
      leaseDurationMs: reservation.leaseDurationMs,
      now: options.now(),
      forceTakeover,
    },
    1,
  );
  if (acquired.state === "busy") {
    throw new CompletionAdmissionServiceError(
      "request_conflict",
      `completion request is already in progress: ${request.id}`,
    );
  }
  if (acquired.state === "admitted") throw requestConflict(request.id);
  const assertReservation = () =>
    assertCompletionReservationLease({
      workItemHash: item.hash,
      requestId: request.id,
      reservationId: acquired.reservation.id,
      ownerId: reservation.ownerId,
      fence: acquired.reservation.fence,
      now: options.now(),
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
    throw new CompletionAdmissionServiceError(
      "request_conflict",
      `completion reservation is required: ${requestId}`,
    );
  }
  assertion();
}

async function resumeCompletionAtHead(
  adapter: NonNullable<ReturnType<typeof Storage.get>["workItem"]>,
  workItemHash: string,
  admissionId: string,
  completionReport: WorkItem.CompletionReport,
  reservation: CompletionReservationOptions | undefined,
  options: CompletionAdmissionServiceOptions,
): Promise<WorkItem.Info> {
  const item = requiredItem(adapter.get(workItemHash), workItemHash);
  assertNotFailedOrCancelled(item);
  const admission = item.completionFacts.admissions.find(({ id }) => id === admissionId);
  if (!admission) throw admissionRequired(workItemHash, admissionId);
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
  const request = requestFromAdmission(item, admission);
  const durableReservation = item.completionFacts.requestReservations.find(
    ({ requestId }) => requestId === admission.requestId,
  );
  const recoveryReservation =
    reservation && durableReservation
      ? {
          ...reservation,
          requestRoot: durableReservation.requestRoot,
          envelopeDigest: durableReservation.envelopeDigest,
        }
      : reservation;
  const assertReservation =
    recoveryReservation === undefined
      ? undefined
      : reserveCompletionLease(
          item,
          admission.requestSnapshot,
          completionReport,
          recoveryReservation,
          options,
          true,
        );
  assertReservation?.();
  if (isAdmitted(admission) && assertReservation) {
    const reservedItem = requiredItem(adapter.get(workItemHash), workItemHash);
    if (
      reservedItem.revision === assertReservation.recordedHead &&
      hasContiguousReservationBridge(reservedItem, admission)
    ) {
      return commitTerminal(
        adapter,
        reservedItem,
        admission,
        completionReport,
        options.now(),
        assertReservation,
        true,
      );
    }
  }
  if (item.revision === admission.recordedHead) {
    if (!isAdmitted(admission)) return item;
    return commitTerminal(
      adapter,
      item,
      admission,
      completionReport,
      options.now(),
      assertReservation,
    );
  }

  const nextAdmission = canonicalAdmission(
    await resolveAuthority(options, item, request),
    completionReport,
  );
  assertAdmissionMatches(nextAdmission, item, request);
  assertReservation?.();
  options.beforeAdmissionWrite?.();
  assertUnchangedAfterAuthority(adapter, item);
  const recorded = await appendAdmission(adapter, item, request, nextAdmission);
  if (!isAdmitted(nextAdmission)) return recorded;
  return commitTerminal(
    adapter,
    recorded,
    nextAdmission,
    completionReport,
    options.now(),
    assertReservation,
  );
}

async function replayRequest(
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  completionReport: WorkItem.CompletionReport,
  admissions: readonly WorkItem.CompletionAdmission[],
  options: CompletionAdmissionServiceOptions,
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
  if (options.reservation !== undefined) {
    assertLiveReservation(assertReservation, request.id);
  }
  if (!isAdmitted(admission)) {
    if (item.revision === admission.recordedHead) {
      return { admission, workItem: item, completed: false };
    }
    return completeOrReevaluate(
      authorizedCompletionAdapter(requiredAdapter(item.hash), options.completionWriter),
      item,
      request,
      completionReport,
      admission,
      options,
      assertReservation,
    );
  }
  if (item.revision === admission.recordedHead) {
    const completed = commitTerminal(
      authorizedCompletionAdapter(requiredAdapter(item.hash), options.completionWriter),
      item,
      admission,
      completionReport,
      options.now(),
      assertReservation,
    );
    return { admission, workItem: completed, completed: true };
  }
  if (
    assertReservation?.recordedHead === item.revision &&
    hasContiguousReservationBridge(item, admission)
  ) {
    const completed = commitTerminal(
      authorizedCompletionAdapter(requiredAdapter(item.hash), options.completionWriter),
      item,
      admission,
      completionReport,
      options.now(),
      assertReservation,
      true,
    );
    return { admission, workItem: completed, completed: true };
  }
  return completeOrReevaluate(
    authorizedCompletionAdapter(requiredAdapter(item.hash), options.completionWriter),
    item,
    request,
    completionReport,
    admission,
    options,
    assertReservation,
  );
}

async function completeOrReevaluate(
  adapter: NonNullable<ReturnType<typeof Storage.get>["workItem"]>,
  recorded: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  completionReport: WorkItem.CompletionReport,
  admission: WorkItem.CompletionAdmission,
  options: CompletionAdmissionServiceOptions,
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
      options.now(),
      assertReservation,
    );
    return { admission, workItem: completed, completed: true };
  }
  assertSameBasis(latest, admission);

  const recheck = requestAtHead(request, latest.revision);
  const nextAdmission = canonicalAdmission(
    await resolveAuthority(options, latest, recheck),
    completionReport,
  );
  assertAdmissionMatches(nextAdmission, latest, recheck);
  assertReservation?.();
  options.beforeAdmissionWrite?.();
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
    assertReservation,
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
  const proposed = admission.requestSnapshot;
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
  assertReservation: (() => void) | undefined,
  reservationBridged = false,
): WorkItem.Info {
  const current = requiredItem(adapter.get(existing.hash), existing.hash);
  assertNotFailedOrCancelled(current);
  assertTerminalEligibleAdmission(admission);
  if (
    current.revision !== existing.revision ||
    (!reservationBridged && current.revision !== admission.recordedHead)
  ) {
    throw new CompletionAdmissionServiceError(
      "stale_head",
      `WorkItem changed before terminal completion: ${existing.hash}`,
    );
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
  const factIds = [
    ...item.completionFacts.criteria,
    ...item.completionFacts.claims,
    ...item.completionFacts.observations,
    ...item.completionFacts.results,
    ...item.completionFacts.invalidations,
    ...item.completionFacts.verificationErrors,
    ...item.completionFacts.effects,
    ...item.completionFacts.admissions,
    ...item.completionFacts.requestReservations,
    ...request.claims,
    ...request.observations,
    ...request.results,
    ...request.invalidations,
    ...request.verificationErrors,
    ...request.effects,
  ].map(({ id }) => id);
  if (factIds.includes(admission.id)) {
    throw requestConflict(request.id);
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
    const results = [...item.completionFacts.results, ...request.results];
    const effectiveResults = admission.effectiveResultIds.map((resultId) =>
      results.find(({ id }) => id === resultId),
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
    const resolvedCriterionIds = new Set(
      effectiveResults.flatMap((result) => (result ? [result.criterionId] : [])),
    );
    const expectedUnresolvedCriterionIds = item.completionFacts.criteria
      .filter((criterion) => criterion.required && !resolvedCriterionIds.has(criterion.id))
      .map(({ id }) => id)
      .sort();
    const actualUnresolvedCriterionIds = [...admission.unresolvedCriterionIds].sort();
    if (
      expectedUnresolvedCriterionIds.length !== actualUnresolvedCriterionIds.length ||
      expectedUnresolvedCriterionIds.some(
        (criterionId, index) => criterionId !== actualUnresolvedCriterionIds[index],
      ) ||
      (admission.decision === "admit" && expectedUnresolvedCriterionIds.length > 0)
    ) {
      throw requestConflict(request.id);
    }
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
  const requestAtOriginalHead =
    original === undefined
      ? request
      : WorkItem.CompletionRequest.parse({
          ...request,
          expectedHead: original.expectedHead,
        });
  if (
    !original ||
    original.origin !== request.origin ||
    original.contractRevision !== request.contractRevision ||
    original.basisRef !== request.basisRef ||
    !completionRequestsMatch(original.requestSnapshot, requestAtOriginalHead)
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

function requestAtHead(
  request: WorkItem.CompletionRequest,
  expectedHead: number,
): WorkItem.CompletionRequest {
  const { ownerOverrideReceiptRef: _staleOwnerReceipt, ...unboundRequest } = request;
  return WorkItem.CompletionRequest.parse({
    ...unboundRequest,
    expectedHead,
    claims: [],
    observations: [],
    results: [],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  });
}

async function resolveAuthority(
  options: CompletionAdmissionServiceOptions,
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
): Promise<WorkItem.CompletionAdmission> {
  try {
    return await options.authorityResolver.resolve(item, request);
  } catch (error) {
    if (
      error instanceof CompletionAdmissionError ||
      error instanceof CompletionAdmissionServiceError
    ) {
      throw error;
    }
    throw new CompletionAdmissionServiceError(
      "authority_unavailable",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function rebaseCompletionRequestAtHead(
  request: WorkItem.CompletionRequest,
  expectedHead: number,
): WorkItem.CompletionRequest {
  const { ownerOverrideReceiptRef: _staleOwnerReceipt, ...unboundRequest } = request;
  return WorkItem.CompletionRequest.parse({
    ...unboundRequest,
    expectedHead,
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
    sourceIdentity: admission.requestSnapshot.sourceIdentity,
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
  const completionReportSnapshot = WorkItem.canonicalCompletionReport(completionReport);
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

function assertRequesterFactsSupported(
  request: WorkItem.CompletionRequest,
  allowTrustedInvalidations: boolean,
): void {
  if (request.invalidations.length > 0 && !allowTrustedInvalidations) {
    throw new CompletionAdmissionServiceError(
      "unsupported_fact",
      "completion request invalidations require the trusted invalidation boundary",
    );
  }
  if (request.effects.length === 0) return;
  throw new CompletionAdmissionServiceError(
    "unsupported_fact",
    "completion requests cannot propose effects without trusted authority",
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

function hasContiguousReservationBridge(
  item: WorkItem.Info,
  admission: WorkItem.CompletionAdmission,
): boolean {
  const expectedCount = item.revision - admission.recordedHead;
  if (expectedCount <= 0) return false;
  const reservations = item.completionFacts.requestReservations.filter(
    ({ recordedHead, requestId }) =>
      requestId === admission.requestId &&
      recordedHead > admission.recordedHead &&
      recordedHead <= item.revision,
  );
  const heads = new Set(reservations.map(({ recordedHead }) => recordedHead));
  return (
    reservations.length === expectedCount &&
    heads.size === expectedCount &&
    Array.from({ length: expectedCount }, (_, index) => admission.recordedHead + index + 1).every(
      (head) => heads.has(head),
    )
  );
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

function authorizedCompletionAdapter(
  adapter: NonNullable<ReturnType<typeof Storage.get>["workItem"]>,
  completionWriter: Storage.WorkItemCompletionWriter,
): NonNullable<ReturnType<typeof Storage.get>["workItem"]> {
  return {
    ...adapter,
    compareAndSet: completionWriter,
  };
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
