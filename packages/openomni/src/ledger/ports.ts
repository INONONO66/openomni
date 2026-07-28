import {
  Execution as ExecutionSchema,
  type Execution,
  type Ledger,
  type Wait,
} from "@openomni/protocol";
import type { Ledger as SessionLedger } from "@openomni/session";

export type AuthenticatedWorkerIdentityV1 = Execution.AuthenticatedWorkerIdentityV1;
export type KernelTransitionCommandV1 = Execution.KernelTransitionCommandV1;
export type KernelTransitionResultV1 = Execution.KernelTransitionResultV1;
export type KernelQueryV1 = Execution.KernelQueryV1;
export type KernelQueryResultV1 = Execution.KernelQueryResultV1;

export interface AuthoritativeArtifactBlobV1 {
  readonly bytes: Uint8Array;
  readonly expectedHash: `sha256:${string}`;
}

export interface AuthoritativeBlobV1 {
  readonly hash: `sha256:${string}`;
  readonly bytes: Uint8Array;
  readonly size: number;
}

/** Host-only, content-hash-bounded structural blob reader. Never provision this port to a worker. */
export interface AuthoritativeBlobReaderPortV1 {
  readBlob(hash: `sha256:${string}`): Promise<AuthoritativeBlobV1 | undefined>;
}

export interface AuthoritativeAppendOptionsV1 {
  readonly artifactBlobs?: readonly AuthoritativeArtifactBlobV1[];
}

/** Server-held structural writer. This port is never provisioned to a worker. */
export interface AuthoritativeWriterPortV1 {
  appendBatch(
    request: Ledger.AppendBatchRequestV1,
    options?: AuthoritativeAppendOptionsV1,
  ): Promise<Ledger.AppendReceiptV1>;
  findReceipt(requestId: string): Promise<Ledger.AppendReceiptV1 | null>;
  readHead(owner: Ledger.OwnerV1): Promise<Ledger.HeadV1>;
}

export interface KernelOwnerEventReaderPortV1 {
  readOwnerEvents(
    owner: Ledger.OwnerV1,
    throughOwnerSeq: number,
  ): Promise<readonly Ledger.EnvelopeV1[]>;
}

export interface SessionLedgerQueryCapabilityV1 {
  head(owner: Ledger.OwnerV1): Ledger.HeadV1;
  appendResult(requestId: string): Ledger.AppendReceiptV1 | undefined;
  eventsByOwnerSequence(
    owner: Ledger.OwnerV1,
    range: { readonly throughOwnerSeq: number; readonly limit?: number },
  ): readonly Ledger.EnvelopeV1[];
  session(sessionId: string): SessionLedger.SessionProjection | undefined;
  message(messageId: string): SessionLedger.MessageProjection | undefined;
  messagesBySession(sessionId: string): readonly SessionLedger.MessageProjection[];
  interruptedMessages(): readonly SessionLedger.MessageProjection[];
  surfaceBinding(surfaceId: string): SessionLedger.SurfaceBindingProjection | undefined;
  actorIdentity(actorId: string): SessionLedger.ActorIdentityProjection | undefined;
  actorEndpoint(endpointId: string): SessionLedger.ActorEndpointProjection | undefined;
  blacklistEntries(): readonly SessionLedger.BlacklistProjection[];
  channelGrant(channelId: string): SessionLedger.ChannelGrantProjection | undefined;
  workerGrantsByAttempt(attemptId: string): readonly SessionLedger.WorkerGrantProjection[];
  schedule(scheduleId: string): SessionLedger.ScheduleProjection | undefined;
  dueSchedules(atDbMs: number, limit: number): readonly SessionLedger.ScheduleProjection[];
  connectorInstallation(
    installationId: string,
  ): SessionLedger.ConnectorInstallationProjection | undefined;
  work(workItemId: string): SessionLedger.WorkProjection | undefined;
  openWorks(): readonly SessionLedger.WorkProjection[];
  attempt(attemptId: string): SessionLedger.AttemptProjection | undefined;
  attemptByRunId(runId: string): SessionLedger.AttemptProjection | undefined;
  attemptsByWork(workItemId: string): readonly SessionLedger.AttemptProjection[];
  attemptsBySession(sessionId: string): readonly SessionLedger.AttemptProjection[];
  interruptedAttempts(): readonly SessionLedger.AttemptProjection[];
  wait(waitId: string): SessionLedger.WaitProjection | undefined;
  waitCandidates(endpointId?: string, channelId?: string): readonly SessionLedger.WaitProjection[];
  waitsByAttempt(attemptId: string): readonly SessionLedger.WaitProjection[];
  dispatch(dispatchId: string): SessionLedger.DispatchProjection | undefined;
  completion(candidateId: string): SessionLedger.CompletionProjection | undefined;
  completionsByWork(workItemId: string): readonly SessionLedger.CompletionProjection[];
  effect(effectId: string): SessionLedger.EffectProjection | undefined;
  effectsByAttempt(attemptId: string): readonly SessionLedger.EffectProjection[];
}

/** The narrow structural subset of @openomni/session's sole-writer LedgerRuntime. */
export interface SessionLedgerRuntimePortV1 {
  append(
    request: Ledger.AppendBatchRequestV1,
    options?: AuthoritativeAppendOptionsV1,
  ): Promise<Ledger.AppendReceiptV1>;
  query<T>(callback: (query: SessionLedgerQueryCapabilityV1) => T): Promise<T>;
  readBlob(hash: `sha256:${string}`): Promise<AuthoritativeBlobV1 | undefined>;
}

export interface AuthoritativeSessionLedgerPortsV1 {
  readonly writer: AuthoritativeWriterPortV1;
  readonly ownerEvents: KernelOwnerEventReaderPortV1;
  readonly blobs: AuthoritativeBlobReaderPortV1;
}

/** Keeps the session runtime's generic append/query capabilities on the server side. */
export function bindAuthoritativeSessionLedgerRuntime(
  runtime: SessionLedgerRuntimePortV1,
): AuthoritativeSessionLedgerPortsV1 {
  const writer: AuthoritativeWriterPortV1 = Object.freeze({
    appendBatch: (request: Ledger.AppendBatchRequestV1, options?: AuthoritativeAppendOptionsV1) =>
      runtime.append(request, options),
    findReceipt: (requestId: string) =>
      runtime.query((query) => query.appendResult(requestId) ?? null),
    readHead: (owner: Ledger.OwnerV1) => runtime.query((query) => query.head(owner)),
  });
  const ownerEvents: KernelOwnerEventReaderPortV1 = Object.freeze({
    readOwnerEvents: (owner: Ledger.OwnerV1, throughOwnerSeq: number) =>
      runtime.query((query) =>
        query.eventsByOwnerSequence(owner, {
          throughOwnerSeq,
          limit: Math.max(1, throughOwnerSeq),
        }),
      ),
  });
  const blobs: AuthoritativeBlobReaderPortV1 = Object.freeze({
    readBlob: (hash: `sha256:${string}`) => runtime.readBlob(hash),
  });
  return Object.freeze({ writer, ownerEvents, blobs });
}

export type KernelLedgerFailureClassV1 =
  | "transition_parse"
  | "transition_guard"
  | "append"
  | "projection"
  | "observation_publication";

export interface KernelLedgerIncidentV1 {
  readonly version: "kernel-ledger-incident-v1";
  readonly failureClass: KernelLedgerFailureClassV1;
  readonly outcome: "rejected" | "committed" | "thrown";
  readonly code:
    | Extract<KernelTransitionResultV1, { status: "rejected" }>["code"]
    | "projection_failed"
    | "observation_publication_failed";
  /** Monotonic process-local evidence for this structural failure class. */
  readonly occurrence: number;
}

/** Receives only closed, secret-free structural incidents; implementations must sanitize at egress. */
export interface KernelLedgerIncidentSinkV1 {
  report(incident: KernelLedgerIncidentV1): void;
}

export interface KernelLedgerDiagnosticCountersV1 {
  readonly transitionParse: number;
  readonly transitionGuard: number;
  readonly append: number;
  readonly projection: number;
  readonly observationPublication: number;
  readonly incidentSink: number;
}
/** Kernel-owned semantic transition face. It deliberately has no generic append method. */
export interface KernelTransitionPortV1 {
  execute(command: KernelTransitionCommandV1): Promise<KernelTransitionResultV1>;
}

/** Closed authenticated projection query face. It deliberately has no SQL or adapter escape hatch. */
export interface KernelQueryPortV1 {
  query(request: KernelQueryV1): Promise<KernelQueryResultV1>;
}

/** Kernel-internal closed projection reader. It exposes no generic SQL/query callback. */
export interface KernelProjectionPortV1 {
  query(request: KernelQueryV1): Promise<KernelQueryResultV1>;
}

export type WorkerTargetBindingFieldV1 =
  | keyof AuthenticatedWorkerIdentityV1
  | "owner"
  | "workItemId"
  | "attemptSeq"
  | "waitId"
  | "effectId"
  | "effectScope";

export class WorkerIdentityMismatchError extends Error {
  readonly code = "identity_mismatch" as const;

  constructor(readonly field: WorkerTargetBindingFieldV1) {
    super(`authenticated worker identity mismatch: ${field}`);
    this.name = "WorkerIdentityMismatchError";
  }
}

export class WorkerTransitionForbiddenError extends Error {
  readonly code = "transition_forbidden" as const;

  constructor(readonly transitionId: string) {
    super(`transition is not available to authenticated Workers: ${transitionId}`);
    this.name = "WorkerTransitionForbiddenError";
  }
}

const IDENTITY_FIELDS = [
  "runtimeId",
  "workerId",
  "generation",
  "principalId",
  "sessionId",
  "runId",
  "attemptId",
] as const;

export function assertAuthenticatedWorkerIdentity(
  authenticated: AuthenticatedWorkerIdentityV1,
  claimed: AuthenticatedWorkerIdentityV1,
): void {
  if (
    authenticated.version !== "authenticated-worker-identity-v1" ||
    claimed.version !== authenticated.version
  ) {
    throw new WorkerIdentityMismatchError("version");
  }
  for (const field of IDENTITY_FIELDS) {
    if (authenticated[field] !== claimed[field]) throw new WorkerIdentityMismatchError(field);
  }
}

export function assertKernelTransitionIdentity(
  authenticated: AuthenticatedWorkerIdentityV1,
  command: KernelTransitionCommandV1,
): void {
  assertAuthenticatedWorkerIdentity(authenticated, command.identity);
}

type WithoutIdentity<T> = T extends { readonly identity: AuthenticatedWorkerIdentityV1 }
  ? Omit<T, "identity">
  : never;

/** Complete ledger target facts resolved and retained by the server for this worker channel. */
export interface AuthenticatedWorkerTargetBindingV1 {
  readonly owner: Ledger.OwnerV1;
  readonly attempt: Ledger.AttemptRefV1;
  readonly waitIds: readonly string[];
  readonly effects: readonly {
    readonly effect: Ledger.EffectRefV1;
    readonly effectScope: Execution.EffectScopeV1;
  }[];
}

function assertAttemptBinding(bound: Ledger.AttemptRefV1, claimed: Ledger.AttemptRefV1): void {
  if (claimed.workItemId !== bound.workItemId) throw new WorkerIdentityMismatchError("workItemId");
  if (claimed.attemptId !== bound.attemptId) throw new WorkerIdentityMismatchError("attemptId");
  if (claimed.attemptSeq !== bound.attemptSeq) throw new WorkerIdentityMismatchError("attemptSeq");
}

function assertWaitBinding(binding: AuthenticatedWorkerTargetBindingV1, waitId: string): void {
  if (!binding.waitIds.includes(waitId)) throw new WorkerIdentityMismatchError("waitId");
}

const WORKER_TRANSITION_IDS = new Set([
  "AT-03",
  "AT-07",
  "AT-08",
  "AT-09",
  "AT-13",
  "WI-06",
  "WI-07",
  "WI-08",
  "CP-01",
  "WT-01",
  "WT-08",
]);

function assertWorkerAllowedTransition(transitionId: string): void {
  if (!WORKER_TRANSITION_IDS.has(transitionId)) {
    throw new WorkerTransitionForbiddenError(transitionId);
  }
}

function assertRunBinding(
  binding: AuthenticatedWorkerTargetBindingV1,
  identity: AuthenticatedWorkerIdentityV1,
  claimed: Readonly<Record<string, unknown>>,
): void {
  if (claimed.workItemId !== binding.attempt.workItemId)
    throw new WorkerIdentityMismatchError("workItemId");
  if (claimed.attemptId !== binding.attempt.attemptId)
    throw new WorkerIdentityMismatchError("attemptId");
  if (claimed.sessionId !== identity.sessionId) throw new WorkerIdentityMismatchError("sessionId");
  if (claimed.runId !== identity.runId) throw new WorkerIdentityMismatchError("runId");
}

function assertEffectBinding(
  binding: AuthenticatedWorkerTargetBindingV1,
  fact: Readonly<Record<string, unknown>>,
): void {
  assertAttemptBinding(binding.attempt, fact.attempt as Ledger.AttemptRefV1);
  const claimedEffect = fact.effect as Ledger.EffectRefV1;
  if (fact.subjectId !== claimedEffect.effectId) {
    throw new WorkerIdentityMismatchError("effectId");
  }
  const bound = binding.effects?.find(
    (candidate) => candidate.effect.effectId === claimedEffect.effectId,
  );
  if (bound === undefined || bound.effect.idempotencyKey !== claimedEffect.idempotencyKey) {
    throw new WorkerIdentityMismatchError("effectId");
  }
  if (canonicalValue(bound.effectScope) !== canonicalValue(fact.effectScope)) {
    throw new WorkerIdentityMismatchError("effectScope");
  }
}

function assertWaitEventBinding(
  binding: AuthenticatedWorkerTargetBindingV1,
  identity: AuthenticatedWorkerIdentityV1,
  waitEvent: LedgerWaitEvent,
): void {
  assertWaitBinding(binding, waitEvent.waitId);
  const { ownerRef } = waitEvent;
  if (
    (ownerRef.kind === "workItem" && ownerRef.id !== binding.attempt.workItemId) ||
    (ownerRef.kind === "session" && ownerRef.id !== identity.sessionId)
  ) {
    throw new WorkerIdentityMismatchError(
      ownerRef.kind === "workItem" ? "workItemId" : "sessionId",
    );
  }
  if ("attempt" in waitEvent && waitEvent.attempt !== undefined) {
    assertAttemptBinding(binding.attempt, waitEvent.attempt);
  }
}

type LedgerWaitEvent = Wait.LifecycleEventV1;

function assertTransitionTargetBinding(
  binding: AuthenticatedWorkerTargetBindingV1,
  command: KernelTransitionCommandV1,
): void {
  assertWorkerAllowedTransition(command.transitionId);
  if (
    command.expectedHead.owner.ownerKey !== binding.owner.ownerKey ||
    command.payload.owner.ownerKey !== binding.owner.ownerKey
  ) {
    throw new WorkerIdentityMismatchError("owner");
  }
  if (!("facts" in command.payload)) throw new WorkerTransitionForbiddenError(command.transitionId);
  for (const [family, value] of Object.entries(command.payload.facts)) {
    const fact = value as Readonly<Record<string, unknown>>;
    switch (family) {
      case "AT":
        if (fact.subjectId !== binding.attempt.attemptId)
          throw new WorkerIdentityMismatchError("attemptId");
        assertAttemptBinding(binding.attempt, fact.attempt as Ledger.AttemptRefV1);
        assertRunBinding(
          binding,
          command.identity,
          fact.runBinding as Readonly<Record<string, unknown>>,
        );
        break;
      case "WI":
        if (
          fact.subjectId !== binding.attempt.workItemId ||
          fact.workItemId !== binding.attempt.workItemId
        )
          throw new WorkerIdentityMismatchError("workItemId");
        if (fact.sessionId !== command.identity.sessionId)
          throw new WorkerIdentityMismatchError("sessionId");
        break;
      case "CP":
        if (
          fact.subjectId !== binding.attempt.workItemId ||
          fact.workItemId !== binding.attempt.workItemId
        )
          throw new WorkerIdentityMismatchError("workItemId");
        assertRunBinding(
          binding,
          command.identity,
          fact.runBinding as Readonly<Record<string, unknown>>,
        );
        break;
      case "WT":
        if (typeof fact.subjectId !== "string") throw new WorkerIdentityMismatchError("waitId");
        assertWaitBinding(binding, fact.subjectId);
        if ((fact.waitEvent as LedgerWaitEvent).waitId !== fact.subjectId)
          throw new WorkerIdentityMismatchError("waitId");
        assertWaitEventBinding(binding, command.identity, fact.waitEvent as LedgerWaitEvent);
        break;
      case "EF":
        assertEffectBinding(binding, fact);
        break;
      default:
        throw new WorkerTransitionForbiddenError(command.transitionId);
    }
  }
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`)
    .join(",")}}`;
}

export interface BoundWorkerKernelPortV1 {
  execute(command: WithoutIdentity<KernelTransitionCommandV1>): Promise<KernelTransitionResultV1>;
  query(request: WithoutIdentity<KernelQueryV1>): Promise<KernelQueryResultV1>;
}

/**
 * Binds the identity and complete ledger target established by server-held channel state.
 * Caller claims are checked before either generic kernel port can observe the request.
 */
export function bindAuthenticatedWorkerKernelPort(
  authenticated: AuthenticatedWorkerIdentityV1,
  target: AuthenticatedWorkerTargetBindingV1,
  transitions: KernelTransitionPortV1,
  queries: KernelQueryPortV1,
): BoundWorkerKernelPortV1 {
  assertAttemptBinding(target.attempt, {
    ...target.attempt,
    attemptId: authenticated.attemptId,
  });
  const waitIds = Object.freeze([...target.waitIds]);
  if (waitIds.length !== new Set(waitIds).size || waitIds.some((waitId) => waitId.length === 0)) {
    throw new WorkerIdentityMismatchError("waitId");
  }
  const effects = Object.freeze(target.effects.map((effect) => structuredClone(effect)));
  if (
    effects.length !== new Set(effects.map(({ effect }) => effect.effectId)).size ||
    effects.some(({ effect }) => effect.effectId.length === 0)
  ) {
    throw new WorkerIdentityMismatchError("effectId");
  }
  const binding = Object.freeze({
    owner: Object.freeze({ ...target.owner }),
    attempt: Object.freeze({ ...target.attempt }),
    waitIds,
    effects,
  });
  return Object.freeze({
    execute(command: WithoutIdentity<KernelTransitionCommandV1>) {
      const bound: KernelTransitionCommandV1 = { ...command, identity: authenticated };
      assertKernelTransitionIdentity(authenticated, bound);
      assertTransitionTargetBinding(binding, bound);
      return transitions.execute(bound);
    },
    query(request: WithoutIdentity<KernelQueryV1>) {
      const bound = ExecutionSchema.KernelQueryV1.parse({ ...request, identity: authenticated });
      if (
        bound.kind === "authenticated_transcript" &&
        bound.sessionId !== authenticated.sessionId
      ) {
        throw new WorkerIdentityMismatchError("sessionId");
      }
      if (bound.kind === "authenticated_attempt") {
        assertAttemptBinding(binding.attempt, bound.attempt);
      }
      if (bound.kind === "authenticated_wait") {
        assertWaitBinding(binding, bound.waitId);
      }
      return queries.query(bound);
    },
  });
}
