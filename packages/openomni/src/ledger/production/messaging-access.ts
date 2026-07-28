import { createHash } from "node:crypto";
import { z } from "zod";
import { Actor, Execution, Ledger } from "@openomni/protocol";
import type {
  AuthorityProjectionQueryPort,
  AuthorityProjectionQueryRequest,
  AuthorityProjectionQueryResult,
  AuthoritySourceRefs,
  WorkerGrantProjectionV1,
} from "../../ingress/actor-resolver.js";
import {
  MessagingLedgerServiceError,
  type MessagingLedgerQuery,
  type MessagingLedgerQueryResult,
  type MessagingLedgerService,
  type MessagingLedgerTransition,
  type MessagingLedgerTransitionResult,
  type MessagingSessionInfo,
  type ResidentIngressReceipt,
} from "../../ingress/session-resolver.js";

export interface MessagingAccessSnapshotBlobV1 {
  readonly ref: Execution.ContentBlobRefV1;
  readonly bytes: Uint8Array;
}

export const DefiniteDispatchFailureProofV1 = z
  .object({
    version: z.literal("definite-dispatch-failure-proof-v1"),
    sourceOwnerKey: z.string().min(1),
    dispatchId: z.string().min(1),
    destinationOwnerKey: z.string().min(1),
    destinationRequestId: z.string().min(1),
    destinationHead: Ledger.HeadV1,
    destinationState: z.literal("absent"),
    failureClass: z.literal("destination_append_definite_no_materialization"),
  })
  .strict();

export type DefiniteDispatchFailureProofV1 = z.infer<typeof DefiniteDispatchFailureProofV1>;

/** Parses an already-durable, sanitized proof blob; raw driver errors never cross this boundary. */
export function parseDefiniteDispatchFailureProofBlob(
  blob: MessagingAccessSnapshotBlobV1,
): DefiniteDispatchFailureProofV1 {
  if (blob.ref.mediaType !== "application/json" || blob.bytes.byteLength !== blob.ref.byteLength) {
    throw new TypeError("Definite dispatch failure proof blob metadata is invalid");
  }
  const digest = createHash("sha256").update(blob.bytes).digest("hex");
  if (digest !== blob.ref.digest) {
    throw new TypeError("Definite dispatch failure proof blob digest is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes));
  } catch {
    throw new TypeError("Definite dispatch failure proof blob is not canonical JSON");
  }
  return DefiniteDispatchFailureProofV1.parse(decoded);
}

export type MessagingAccessCommitResultV1 =
  | { readonly status: "committed"; readonly receiptId: string }
  | {
      readonly status: "rejected";
      readonly code:
        | "head_conflict"
        | "idempotency_mismatch"
        | "not_found"
        | "transition_forbidden";
    };

export interface MessagingAccessTransitionPortV1 {
  commit(
    transitionId: MessagingLedgerTransition["kind"],
    payload: Readonly<Record<string, unknown>>,
    artifacts: readonly MessagingAccessSnapshotBlobV1[],
    requestId: string,
  ): Promise<MessagingAccessCommitResultV1>;
}

export interface ProjectionSourceV1 {
  readonly ownerKey: string;
  readonly state: unknown;
  readonly sourceEventId: string;
  readonly sourceOwnerSeq: number;
  readonly sourceLedgerSeq: number;
  readonly sourceOwnerHash: string;
  readonly asOfLedgerSeq: number;
}

export interface SessionProjectionV1 extends ProjectionSourceV1 {
  readonly sessionId: string;
}

export interface MessagingProjectionV1 extends ProjectionSourceV1 {
  readonly messageId: string;
  readonly sessionId: string;
}

export interface SurfaceProjectionV1 extends ProjectionSourceV1 {
  readonly surfaceId: string;
  readonly sessionId: string;
}

export interface ActorIdentityProjectionV1 extends ProjectionSourceV1 {
  readonly actorId: string;
}

export interface ActorEndpointProjectionV1 extends ProjectionSourceV1 {
  readonly endpointId: string;
  readonly actorId: string;
}

export interface BlocklistProjectionV1 extends ProjectionSourceV1 {
  readonly blacklistId: string;
}

export interface ChannelGrantProjectionV1 extends ProjectionSourceV1 {
  readonly grantId: string;
}

export interface AttemptProjectionV1 extends ProjectionSourceV1 {
  readonly attemptId: string;
  readonly workItemId: string;
  readonly sessionId: string;
}

export interface WorkerAttemptGrantProjectionV1 extends ProjectionSourceV1 {
  readonly grantId: string;
  readonly workItemId: string;
  readonly attemptId: string;
}

export interface EffectProjectionV1 extends ProjectionSourceV1 {
  readonly effectId: string;
  readonly workspaceId: string;
  readonly workItemId: string;
  readonly attemptId: string;
}

/** Closed projection reads needed by messaging and access decisions. */
export interface MessagingAccessProjectionReaderV1 {
  session(sessionId: string): Promise<SessionProjectionV1 | undefined>;
  surfaceBinding(surfaceId: string): Promise<SurfaceProjectionV1 | undefined>;
  messagesBySession(sessionId: string): Promise<readonly MessagingProjectionV1[]>;
  actorIdentity(actorId: string): Promise<ActorIdentityProjectionV1 | undefined>;
  actorEndpoint(endpointId: string): Promise<ActorEndpointProjectionV1 | undefined>;
  blocklistEntries(): Promise<readonly BlocklistProjectionV1[]>;
  channelGrant(grantKey: string): Promise<ChannelGrantProjectionV1 | undefined>;
  attemptByRunId(runId: string): Promise<AttemptProjectionV1 | undefined>;
  workerAttemptGrants(attemptId: string): Promise<readonly WorkerAttemptGrantProjectionV1[]>;
  effect(effectId: string): Promise<EffectProjectionV1 | undefined>;
}

export interface MessagingAccessDependenciesV1 {
  readonly transitions: MessagingAccessTransitionPortV1;
  readonly projections: MessagingAccessProjectionReaderV1;
  readonly snapshot: (
    family: "session" | "surface" | "message" | "part" | "route" | "effect",
    state: object,
  ) => MessagingAccessSnapshotBlobV1;
  readonly residentEffectScope: (sourceRef: string) => Execution.EffectScopeV1;
}

export interface MessagingAccessServicesV1 {
  readonly messaging: MessagingLedgerService;
  readonly authority: AuthorityProjectionQueryPort;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function stringField(value: JsonRecord, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: JsonRecord, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function sessionOwner(sessionId: string): Ledger.OwnerV1 {
  return { version: "ledger-owner-v1", ownerKey: `session:${sessionId}` };
}

function sessionInfo(
  command: Extract<MessagingLedgerTransition, { kind: "SS-01" | "SS-02" | "SF-01" }>,
): MessagingSessionInfo {
  return Object.freeze({
    id: command.sessionId,
    ...(command.kind === "SS-02" ? { parentID: command.parentSessionId } : {}),
    title: command.title,
    model: command.model,
    time: { created: command.openedAt, updated: command.openedAt },
    ...(command.kind === "SS-02" ? { workerMeta: command.workerMeta } : {}),
  });
}

function residentSessionInfo(
  command: Extract<MessagingLedgerTransition, { kind: "RT-11" | "RT-12" }>,
): MessagingSessionInfo {
  return Object.freeze({
    id: command.sessionId,
    title: command.title,
    model: command.model,
    time: { created: command.recordedAt, updated: command.recordedAt },
  });
}

function invalidMessagingProjection(): never {
  throw new MessagingLedgerServiceError("messaging_projection_invalid");
}

function validProjectionSource(row: ProjectionSourceV1): boolean {
  return (
    typeof row.sourceEventId === "string" &&
    row.sourceEventId.length > 0 &&
    Number.isInteger(row.sourceOwnerSeq) &&
    row.sourceOwnerSeq > 0 &&
    Number.isInteger(row.sourceLedgerSeq) &&
    row.sourceLedgerSeq > 0 &&
    typeof row.sourceOwnerHash === "string" &&
    row.sourceOwnerHash.length > 0 &&
    Number.isInteger(row.asOfLedgerSeq) &&
    row.asOfLedgerSeq >= row.sourceLedgerSeq
  );
}

function projectionSession(
  row: SessionProjectionV1,
  requestedSessionId: string,
): MessagingSessionInfo {
  const state = record(row.state);
  if (
    row.sessionId !== requestedSessionId ||
    row.ownerKey !== `session:${requestedSessionId}` ||
    !validProjectionSource(row) ||
    state === undefined
  )
    return invalidMessagingProjection();
  const id = stringField(state, "id");
  const title = stringField(state, "title");
  const model = record(state.model);
  const time = record(state.time);
  const providerID = model === undefined ? undefined : stringField(model, "providerID");
  const modelID = model === undefined ? undefined : stringField(model, "modelID");
  const created = time === undefined ? undefined : numberField(time, "created");
  const updated = time === undefined ? undefined : numberField(time, "updated");
  if (
    id !== requestedSessionId ||
    title === undefined ||
    providerID === undefined ||
    modelID === undefined ||
    created === undefined ||
    updated === undefined
  )
    return invalidMessagingProjection();
  const parentID = stringField(state, "parentID");
  const workerMeta = record(state.workerMeta);
  if (
    (state.parentID !== undefined && parentID === undefined) ||
    (state.workerMeta !== undefined && workerMeta === undefined)
  )
    return invalidMessagingProjection();
  return {
    id,
    ...(parentID === undefined ? {} : { parentID }),
    title,
    model: { providerID, modelID },
    time: { created, updated },
    ...(workerMeta === undefined ? {} : { workerMeta }),
  };
}

interface TranscriptMessageV1 {
  readonly role: "user" | "assistant";
  readonly parts: readonly { readonly type: string; readonly text?: string }[];
}

function transcriptMessage(value: unknown): TranscriptMessageV1 {
  const state = record(value);
  const role = state === undefined ? undefined : stringField(state, "role");
  const rawParts = state?.parts;
  if ((role !== "user" && role !== "assistant") || !Array.isArray(rawParts)) {
    throw new MessagingLedgerServiceError("messaging_projection_invalid");
  }
  const parts = rawParts.map((part) => {
    const item = record(part);
    if (item === undefined) {
      throw new MessagingLedgerServiceError("messaging_projection_invalid");
    }
    const type = stringField(item, "type");
    if (type === undefined || (item.text !== undefined && typeof item.text !== "string")) {
      throw new MessagingLedgerServiceError("messaging_projection_invalid");
    }
    const text = stringField(item, "text");
    return { type, ...(text === undefined ? {} : { text }) };
  });
  return { role, parts };
}

function projectionTranscriptMessage(
  row: MessagingProjectionV1,
  requestedSessionId: string,
): TranscriptMessageV1 {
  const state = record(row.state);
  if (
    row.sessionId !== requestedSessionId ||
    row.ownerKey !== `session:${requestedSessionId}` ||
    !validProjectionSource(row) ||
    state === undefined ||
    stringField(state, "id") !== row.messageId ||
    stringField(state, "sessionId") !== requestedSessionId
  )
    return invalidMessagingProjection();
  return transcriptMessage(state);
}

function surfaceKind(surfaceKey: string): string {
  const separator = surfaceKey.indexOf(":");
  return separator <= 0 ? "unknown" : surfaceKey.slice(0, separator);
}

function residentAttempt(sessionId: string, messageId: string): Ledger.AttemptRefV1 {
  return {
    version: "attempt-ref-v1",
    workItemId: `resident:${sessionId}`,
    attemptId: `resident:${messageId}`,
    attemptSeq: 1,
  };
}

function commitResult(
  result: MessagingAccessCommitResultV1,
  residentReceipt?: ResidentIngressReceipt,
): MessagingLedgerTransitionResult {
  if (result.status === "rejected") return result;
  return { status: "committed", ...(residentReceipt === undefined ? {} : { residentReceipt }) };
}

async function executeSession(
  dependencies: MessagingAccessDependenciesV1,
  command: Extract<MessagingLedgerTransition, { kind: "SS-01" | "SS-02" | "SF-01" }>,
): Promise<MessagingLedgerTransitionResult> {
  const session = sessionInfo(command);
  const owner = sessionOwner(command.sessionId);
  const sessionBlob = dependencies.snapshot("session", session);
  if (command.kind !== "SF-01") {
    const result = await dependencies.transitions.commit(
      command.kind,
      {
        owner,
        subjectId: command.sessionId,
        occurredAtDbMs: command.openedAt,
        sessionId: command.sessionId,
        parentSessionId: command.kind === "SS-02" ? command.parentSessionId : null,
        model: { provider: command.model.providerID, id: command.model.modelID },
        sessionSnapshotRef: sessionBlob.ref,
      },
      [sessionBlob],
      `messaging:${command.kind}:${command.sessionId}`,
    );
    return result.status === "rejected" ? result : { status: "committed", session, isNew: true };
  }
  const surface = Object.freeze({
    surfaceKey: command.surfaceKey,
    sessionId: command.sessionId,
    surfaceKind: surfaceKind(command.surfaceKey),
    endpointId: command.surfaceKey,
  });
  const surfaceBlob = dependencies.snapshot("surface", surface);
  const result = await dependencies.transitions.commit(
    "SF-01",
    {
      owner,
      subjectId: command.surfaceKey,
      occurredAtDbMs: command.openedAt,
      sessionId: command.sessionId,
      surfaceId: command.surfaceKey,
      surfaceKind: surface.surfaceKind,
      endpointId: command.surfaceKey,
      surfaceSnapshotRef: surfaceBlob.ref,
      projections: {
        SS: {
          owner,
          subjectId: command.sessionId,
          occurredAtDbMs: command.openedAt,
          sessionId: command.sessionId,
          parentSessionId: null,
          model: { provider: command.model.providerID, id: command.model.modelID },
          sessionSnapshotRef: sessionBlob.ref,
        },
      },
    },
    [surfaceBlob, sessionBlob],
    `messaging:SF-01:${command.surfaceKey}`,
  );
  return result.status === "rejected" ? result : { status: "committed", session, isNew: true };
}

async function executeMessage(
  dependencies: MessagingAccessDependenciesV1,
  command: Extract<MessagingLedgerTransition, { kind: "MS-01" | "MS-06" }>,
): Promise<MessagingLedgerTransitionResult> {
  const role = command.kind === "MS-01" ? "user" : command.role;
  const model =
    command.kind === "MS-01"
      ? { provider: command.model.providerID, id: command.model.modelID }
      : command.model;
  const part = Object.freeze({
    id: command.partId,
    type: "text",
    text: command.text,
    partOrdinal: 0,
  });
  const message = Object.freeze({
    id: command.messageId,
    sessionId: command.sessionId,
    role,
    status: "complete",
    model,
    ...(command.kind === "MS-06" ? { agent: command.agent } : {}),
    parts: [part],
    recordedAt: command.recordedAt,
  });
  const messageBlob = dependencies.snapshot("message", message);
  const partBlob = dependencies.snapshot("part", part);
  if (command.kind === "MS-01") {
    const owner = sessionOwner(command.sessionId);
    const routeId = `route:${command.messageId}`;
    const route = Object.freeze({
      decision: "accepted",
      routeId,
      sessionId: command.sessionId,
      surfaceId: command.event.surface,
      messageId: command.messageId,
    });
    const sourceRef = command.event.id;
    const effectId = `resident-run:${command.messageId}`;
    const attempt = residentAttempt(command.sessionId, command.messageId);
    const effectScope = dependencies.residentEffectScope(sourceRef);
    const effect = Object.freeze({
      effectId,
      attempt,
      sourceRef,
      settlement: "pending",
      operation: "resident.run.v1",
      scope: effectScope,
    });
    const routeBlob = dependencies.snapshot("route", route);
    const effectBlob = dependencies.snapshot("effect", effect);
    const result = await dependencies.transitions.commit(
      "MS-01",
      {
        owner,
        subjectId: routeId,
        occurredAtDbMs: command.recordedAt,
        sessionId: command.sessionId,
        surfaceId: command.event.surface,
        messageId: command.messageId,
        routeId,
        routeDecision: "accepted",
        authoritySnapshotRef: routeBlob.ref,
        routeSnapshotRef: routeBlob.ref,
        projections: {
          RT: {
            owner,
            subjectId: routeId,
            occurredAtDbMs: command.recordedAt,
            sessionId: command.sessionId,
            surfaceId: command.event.surface,
            messageId: command.messageId,
            routeId,
            routeDecision: "accepted",
            authoritySnapshotRef: routeBlob.ref,
            routeSnapshotRef: routeBlob.ref,
          },
          MS: {
            owner,
            subjectId: command.messageId,
            occurredAtDbMs: command.recordedAt,
            sessionId: command.sessionId,
            surfaceId: command.event.surface,
            messageId: command.messageId,
            partId: command.partId,
            role,
            status: "complete",
            model,
            messageSnapshotRef: messageBlob.ref,
            partSnapshotRef: partBlob.ref,
          },
          EF: {
            owner,
            subjectId: effectId,
            occurredAtDbMs: command.recordedAt,
            effect: { version: "effect-ref-v1", effectId, idempotencyKey: sourceRef },
            attempt,
            effectScope,
            effectScopeRef: effectBlob.ref,
            settlement: "pending",
            effectSettlementRef: effectBlob.ref,
          },
        },
      },
      [messageBlob, partBlob, routeBlob, effectBlob],
      `messaging:MS-01:${command.messageId}`,
    );
    return commitResult(result);
  }
  const result = await dependencies.transitions.commit(
    command.kind,
    {
      owner: sessionOwner(command.sessionId),
      subjectId: command.messageId,
      occurredAtDbMs: command.recordedAt,
      sessionId: command.sessionId,
      surfaceId: "internal",
      messageId: command.messageId,
      partId: command.partId,
      role,
      status: "complete",
      model,
      messageSnapshotRef: messageBlob.ref,
      partSnapshotRef: partBlob.ref,
    },
    [messageBlob, partBlob],
    `messaging:${command.kind}:${command.messageId}`,
  );
  return commitResult(result);
}

async function executeResidentIngress(
  dependencies: MessagingAccessDependenciesV1,
  command: Extract<MessagingLedgerTransition, { kind: "RT-11" | "RT-12" }>,
): Promise<MessagingLedgerTransitionResult> {
  // OpenOmni owns the semantic claim check. The session projection transaction independently
  // enforces structural uniqueness so a stale concurrent RT-12 observation cannot overwrite it.
  if (command.kind === "RT-12") {
    const binding = await dependencies.projections.surfaceBinding(command.surfaceKey);
    if (binding !== undefined && binding.sessionId !== command.sessionId) {
      return { status: "rejected", code: "head_conflict" };
    }
  } else {
    const [session, binding] = await Promise.all([
      dependencies.projections.session(command.sessionId),
      dependencies.projections.surfaceBinding(command.surfaceKey),
    ]);
    if (session === undefined || binding?.sessionId !== command.sessionId) {
      return { status: "rejected", code: "not_found" };
    }
  }

  const owner = sessionOwner(command.sessionId);
  const session = residentSessionInfo(command);
  const surface = Object.freeze({
    surfaceKey: command.surfaceKey,
    sessionId: command.sessionId,
    surfaceKind: surfaceKind(command.surfaceKey),
    endpointId: command.surfaceKey,
  });
  const part = Object.freeze({
    id: command.partId,
    type: "text",
    text: command.text,
    partOrdinal: 0,
  });
  const message = Object.freeze({
    id: command.messageId,
    sessionId: command.sessionId,
    role: "user" as const,
    status: "complete",
    model: { provider: command.model.providerID, id: command.model.modelID },
    parts: [part],
    recordedAt: command.recordedAt,
  });
  const routeId = `route:${command.messageId}`;
  const route = Object.freeze({
    decision: "accepted",
    routeId,
    sessionId: command.sessionId,
    surfaceId: command.surfaceKey,
    messageId: command.messageId,
  });
  const sourceRef = command.event.id;
  const attempt = residentAttempt(command.sessionId, command.messageId);
  const effectScope = dependencies.residentEffectScope(sourceRef);
  const effect = Object.freeze({
    effectId: command.effectId,
    attempt,
    sourceRef,
    settlement: "pending",
    operation: "resident.run.v1",
    scope: effectScope,
  });
  const messageBlob = dependencies.snapshot("message", message);
  const partBlob = dependencies.snapshot("part", part);
  const routeBlob = dependencies.snapshot("route", route);
  const effectBlob = dependencies.snapshot("effect", effect);
  const artifacts: MessagingAccessSnapshotBlobV1[] = [messageBlob, partBlob, routeBlob, effectBlob];
  const projections: Record<string, unknown> = {
    RT: {
      owner,
      subjectId: routeId,
      occurredAtDbMs: command.recordedAt,
      sessionId: command.sessionId,
      surfaceId: command.surfaceKey,
      messageId: command.messageId,
      routeId,
      routeDecision: "accepted",
      authoritySnapshotRef: routeBlob.ref,
      routeSnapshotRef: routeBlob.ref,
    },
    MS: {
      owner,
      subjectId: command.messageId,
      occurredAtDbMs: command.recordedAt,
      sessionId: command.sessionId,
      surfaceId: command.surfaceKey,
      messageId: command.messageId,
      partId: command.partId,
      role: "user",
      status: "complete",
      model: message.model,
      messageSnapshotRef: messageBlob.ref,
      partSnapshotRef: partBlob.ref,
    },
    EF: {
      owner,
      subjectId: command.effectId,
      occurredAtDbMs: command.recordedAt,
      effect: { version: "effect-ref-v1", effectId: command.effectId, idempotencyKey: sourceRef },
      attempt,
      effectScope,
      effectScopeRef: effectBlob.ref,
      settlement: "pending",
      effectSettlementRef: effectBlob.ref,
    },
  };
  if (command.kind === "RT-12") {
    const sessionBlob = dependencies.snapshot("session", session);
    const surfaceBlob = dependencies.snapshot("surface", surface);
    artifacts.push(sessionBlob, surfaceBlob);
    projections.SS = {
      owner,
      subjectId: command.sessionId,
      occurredAtDbMs: command.recordedAt,
      sessionId: command.sessionId,
      parentSessionId: null,
      model: message.model,
      sessionSnapshotRef: sessionBlob.ref,
    };
    projections.SF = {
      owner,
      subjectId: command.surfaceKey,
      occurredAtDbMs: command.recordedAt,
      sessionId: command.sessionId,
      surfaceId: command.surfaceKey,
      surfaceKind: surface.surfaceKind,
      endpointId: command.surfaceKey,
      surfaceSnapshotRef: surfaceBlob.ref,
    };
  }
  const result = await dependencies.transitions.commit(
    command.kind,
    {
      owner,
      subjectId: routeId,
      occurredAtDbMs: command.recordedAt,
      sessionId: command.sessionId,
      surfaceId: command.surfaceKey,
      messageId: command.messageId,
      routeId,
      routeDecision: "accepted",
      authoritySnapshotRef: routeBlob.ref,
      routeSnapshotRef: routeBlob.ref,
      projections,
    },
    artifacts,
    command.requestId,
  );
  const receipt: ResidentIngressReceipt = {
    requestId: command.requestId,
    sessionId: command.sessionId,
    messageId: command.messageId,
    partId: command.partId,
    effectId: command.effectId,
    isNewSession: command.kind === "RT-12",
  };
  return commitResult(result, receipt);
}

async function executeSettlement(
  dependencies: MessagingAccessDependenciesV1,
  command: Extract<MessagingLedgerTransition, { kind: "EF-01" | "EF-02" | "EF-03" }>,
): Promise<MessagingLedgerTransitionResult> {
  const row = await dependencies.projections.effect(command.effectId);
  const state = record(row?.state);
  if (row === undefined || state === undefined) return { status: "rejected", code: "not_found" };
  if (
    row.ownerKey !== `session:${command.sessionId}` ||
    stringField(state, "sourceRef") !== command.sourceRef
  ) {
    return { status: "rejected", code: "transition_forbidden" };
  }
  const parsedAttempt = Ledger.AttemptRefV1.safeParse(state.attempt);
  const parsedScope = Execution.EffectScopeV1.safeParse(state.scope ?? state.effectScope);
  if (!parsedAttempt.success || !parsedScope.success) {
    return { status: "rejected", code: "transition_forbidden" };
  }
  const settlement =
    command.kind === "EF-01"
      ? "confirmed"
      : command.kind === "EF-02"
        ? "definite_failed"
        : "unknown";
  const effect = Object.freeze({
    effectId: command.effectId,
    attempt: parsedAttempt.data,
    sourceRef: command.sourceRef,
    settlement,
    scope: parsedScope.data,
  });
  const blob = dependencies.snapshot("effect", effect);
  const result = await dependencies.transitions.commit(
    command.kind,
    {
      owner: sessionOwner(command.sessionId),
      subjectId: command.effectId,
      occurredAtDbMs: command.settledAt,
      effect: {
        version: "effect-ref-v1",
        effectId: command.effectId,
        idempotencyKey: command.sourceRef,
      },
      attempt: parsedAttempt.data,
      effectScope: parsedScope.data,
      effectScopeRef: blob.ref,
      settlement,
      effectSettlementRef: blob.ref,
    },
    [blob],
    command.requestId,
  );
  return result.status === "rejected" ? result : { status: "committed" };
}

export function createMessagingLedgerService(
  dependencies: MessagingAccessDependenciesV1,
): MessagingLedgerService {
  return Object.freeze({
    async execute(command: MessagingLedgerTransition): Promise<MessagingLedgerTransitionResult> {
      switch (command.kind) {
        case "SS-01":
        case "SS-02":
        case "SF-01":
          return executeSession(dependencies, command);
        case "MS-01":
        case "MS-06":
          return executeMessage(dependencies, command);
        case "RT-11":
        case "RT-12":
          return executeResidentIngress(dependencies, command);
        case "EF-01":
        case "EF-02":
        case "EF-03":
          return executeSettlement(dependencies, command);
      }
    },
    async query(request: MessagingLedgerQuery): Promise<MessagingLedgerQueryResult> {
      if (request.kind === "session") {
        const row = await dependencies.projections.session(request.sessionId);
        return {
          kind: "session",
          session: row === undefined ? null : projectionSession(row, request.sessionId),
        };
      }
      if (request.kind === "surface") {
        const row = await dependencies.projections.surfaceBinding(request.surfaceKey);
        return { kind: "surface", sessionId: row?.sessionId ?? null };
      }
      const rows = await dependencies.projections.messagesBySession(request.sessionId);
      const messages = rows.map((row) => projectionTranscriptMessage(row, request.sessionId));
      return { kind: "transcript", messages };
    },
  });
}

const GENESIS_SOURCE_REFS: AuthoritySourceRefs = Object.freeze({
  sourceEventId: "GENESIS_V1",
  sourceOwnerSeq: 0,
  sourceLedgerSeq: 0,
  sourceOwnerHash: "GENESIS_V1",
  asOfLedgerSeq: 0,
});

function sourceRefs(row: ProjectionSourceV1 | undefined): AuthoritySourceRefs {
  return row === undefined
    ? GENESIS_SOURCE_REFS
    : {
        sourceEventId: row.sourceEventId,
        sourceOwnerSeq: row.sourceOwnerSeq,
        sourceLedgerSeq: row.sourceLedgerSeq,
        sourceOwnerHash: row.sourceOwnerHash,
        asOfLedgerSeq: row.asOfLedgerSeq,
      };
}

function projectionSourceRefs(row: ProjectionSourceV1 | undefined): AuthoritySourceRefs | null {
  if (
    row === undefined ||
    row.sourceEventId.length === 0 ||
    !Number.isSafeInteger(row.sourceOwnerSeq) ||
    !Number.isSafeInteger(row.sourceLedgerSeq) ||
    row.sourceOwnerHash.length === 0 ||
    !Number.isSafeInteger(row.asOfLedgerSeq)
  ) {
    return null;
  }
  return sourceRefs(row);
}

function canonicalNestedState(value: unknown, key: "identity" | "endpoint" | "grant"): unknown {
  return record(value)?.[key];
}

function canonicalChannelGrant(row: ChannelGrantProjectionV1): Actor.ChannelGrant | undefined {
  const state = record(row.state);
  if (
    state === undefined ||
    [
      "id",
      "surface",
      "workspace",
      "channel",
      "kind",
      "defaultTier",
      "inboundTreatment",
      "createdBy",
      "createdAt",
      "updatedAt",
    ].some((key) => state[key] !== undefined)
  ) {
    return undefined;
  }
  const parsed = Actor.ChannelGrant.safeParse(state.grant);
  return parsed.success && parsed.data.id === row.grantId ? parsed.data : undefined;
}

function canonicalBlacklistEntry(row: BlocklistProjectionV1): Actor.BlacklistEntry | undefined {
  const state = record(row.state);
  if (
    state === undefined ||
    ["id", "kind", "value", "reason", "expiresAt", "createdBy", "createdAt", "updatedAt"].some(
      (key) => state[key] !== undefined,
    )
  ) {
    return undefined;
  }
  const parsed = Actor.BlacklistEntry.safeParse(state.entry);
  return parsed.success && parsed.data.id === row.blacklistId ? parsed.data : undefined;
}

function blocklistMatch(
  rows: readonly BlocklistProjectionV1[],
  request: Extract<AuthorityProjectionQueryRequest, { kind: "authority.blacklist_match" }>,
): BlocklistProjectionV1 | undefined {
  const candidates = new Set([
    ...request.candidates,
    ...(request.actorId === undefined ? [] : [request.actorId]),
    ...(request.endpointId === undefined ? [] : [request.endpointId]),
    ...(request.channel === undefined ? [] : [request.channel]),
  ]);
  return rows.find((row) => {
    const state = record(row.state);
    if (state !== undefined && ["revoked", "expired"].includes(String(state.status))) return false;
    const entry = canonicalBlacklistEntry(row);
    if (entry === undefined) return false;
    if (entry.kind === "actor") return request.actorId === entry.value;
    if (entry.kind === "endpoint") return request.endpointId === entry.value;
    if (entry.kind === "channel") return request.channel === entry.value;
    return [...candidates].some((candidate) => candidate.includes(entry.value));
  });
}

async function channelGrantMatch(
  reader: MessagingAccessProjectionReaderV1,
  request: Extract<AuthorityProjectionQueryRequest, { kind: "authority.channel_grant" }>,
): Promise<ChannelGrantProjectionV1 | undefined> {
  const keys = [
    request.channel,
    request.channel === undefined
      ? undefined
      : `${request.surface}:${request.workspace ?? ""}:${request.channel}`,
    request.surface,
  ].filter(
    (key, index, values): key is string => typeof key === "string" && values.indexOf(key) === index,
  );
  const candidates = (await Promise.all(keys.map((key) => reader.channelGrant(key))))
    .filter((row): row is ChannelGrantProjectionV1 => row !== undefined)
    .filter(
      (row, index, rows) =>
        rows.findIndex(
          (candidate) =>
            candidate.grantId === row.grantId && candidate.sourceEventId === row.sourceEventId,
        ) === index,
    );
  const matches = candidates.filter((row) => {
    const state = record(row.state);
    if (state !== undefined && ["revoked", "expired"].includes(String(state.status))) return false;
    const grant = canonicalChannelGrant(row);
    return (
      grant !== undefined &&
      grant.surface === request.surface &&
      (grant.workspace === undefined || grant.workspace === request.workspace) &&
      (grant.channel === undefined || grant.channel === request.channel)
    );
  });
  const exact = matches.filter((row) => canonicalChannelGrant(row)?.channel === request.channel);
  if (request.channel !== undefined && exact.length > 0)
    return exact.length === 1 ? exact[0] : undefined;
  const broad = matches.filter((row) => canonicalChannelGrant(row)?.channel === undefined);
  return broad.length === 1 ? broad[0] : undefined;
}

function activeAttempt(
  row: AttemptProjectionV1 | undefined,
  target: Readonly<{ sessionId: string; runId: string }>,
): Ledger.AttemptRefV1 | undefined {
  const state = record(row?.state);
  if (
    row === undefined ||
    state === undefined ||
    row.sessionId !== target.sessionId ||
    stringField(state, "sessionId") !== target.sessionId ||
    stringField(state, "runId") !== target.runId ||
    stringField(state, "attemptId") !== row.attemptId ||
    stringField(state, "workItemId") !== row.workItemId ||
    !["allocated", "starting", "running", "waiting"].includes(String(state.status))
  )
    return undefined;
  const attempt = {
    version: "attempt-ref-v1",
    workItemId: row.workItemId,
    attemptId: row.attemptId,
    attemptSeq: numberField(state, "attemptSeq"),
  };
  const parsed = Ledger.AttemptRefV1.safeParse(attempt);
  return parsed.success ? parsed.data : undefined;
}

function exactWorkerAttemptGrant(
  row: WorkerAttemptGrantProjectionV1,
  attempt: Ledger.AttemptRefV1,
): WorkerGrantProjectionV1 | undefined {
  const grantState = record(row.state);
  if (
    grantState === undefined ||
    grantState.grant !== undefined ||
    stringField(grantState, "status") !== "active"
  )
    return undefined;
  const parsedAttempt = Ledger.AttemptRefV1.safeParse(grantState.attempt);
  const id = stringField(grantState, "id");
  const version = numberField(grantState, "version");
  const allowedActions = stringArray(grantState.allowedActions);
  if (
    !parsedAttempt.success ||
    id === undefined ||
    id !== row.grantId ||
    row.workItemId !== attempt.workItemId ||
    row.attemptId !== attempt.attemptId ||
    parsedAttempt.data.workItemId !== attempt.workItemId ||
    parsedAttempt.data.attemptId !== attempt.attemptId ||
    parsedAttempt.data.attemptSeq !== attempt.attemptSeq ||
    version === undefined ||
    !Number.isSafeInteger(version) ||
    allowedActions === undefined ||
    typeof grantState.canCreateExternalTasks !== "boolean"
  )
    return undefined;
  const allowedSessionIds = stringArray(grantState.allowedSessionIds);
  const allowedActorIds = stringArray(grantState.allowedActorIds);
  const allowedEndpointIds = stringArray(grantState.allowedEndpointIds);
  const risk = stringField(grantState, "riskCeiling");
  const expiresAt = numberField(grantState, "expiresAt");
  return {
    id,
    attempt,
    status: "active",
    version,
    allowedActions,
    ...(allowedSessionIds === undefined ? {} : { allowedSessionIds }),
    ...(allowedActorIds === undefined ? {} : { allowedActorIds }),
    ...(allowedEndpointIds === undefined ? {} : { allowedEndpointIds }),
    canCreateExternalTasks: grantState.canCreateExternalTasks,
    ...(risk === "low" || risk === "medium" || risk === "high" ? { riskCeiling: risk } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export function createAuthorityProjectionQueryPort(
  reader: MessagingAccessProjectionReaderV1,
): AuthorityProjectionQueryPort {
  return Object.freeze({
    async query(request: AuthorityProjectionQueryRequest): Promise<AuthorityProjectionQueryResult> {
      if (request.kind === "authority.actor_by_endpoint") {
        const endpointId = `${request.surface}:${request.externalId}`;
        const endpointRow = await reader.actorEndpoint(endpointId);
        const endpoint = Actor.Endpoint.safeParse(
          canonicalNestedState(endpointRow?.state, "endpoint"),
        );
        const identityRow =
          endpointRow === undefined ? undefined : await reader.actorIdentity(endpointRow.actorId);
        const identity = Actor.Identity.safeParse(
          canonicalNestedState(identityRow?.state, "identity"),
        );
        const endpointSourceRefs = projectionSourceRefs(endpointRow);
        const identitySourceRefs = projectionSourceRefs(identityRow);
        const bindingsAgree =
          endpoint.success &&
          identity.success &&
          endpointSourceRefs !== null &&
          identitySourceRefs !== null &&
          endpointRow !== undefined &&
          identityRow !== undefined &&
          endpointRow.endpointId === endpointId &&
          endpoint.data.id === endpointId &&
          endpoint.data.channel === request.surface &&
          endpoint.data.externalId === request.externalId &&
          endpoint.data.workspace === request.workspace &&
          endpointRow.actorId === endpoint.data.actorId &&
          identityRow.actorId === endpoint.data.actorId &&
          identity.data.id === endpoint.data.actorId;
        return {
          kind: request.kind,
          identity: bindingsAgree && identity.success ? identity.data : null,
          endpoint: bindingsAgree && endpoint.success ? endpoint.data : null,
          endpointSourceRefs,
          identitySourceRefs,
          ...sourceRefs(endpointRow),
        };
      }
      if (request.kind === "authority.blacklist_match") {
        const row = blocklistMatch(await reader.blocklistEntries(), request);
        return {
          kind: request.kind,
          entry: row === undefined ? null : (canonicalBlacklistEntry(row) ?? null),
          ...sourceRefs(row),
        };
      }
      if (request.kind === "authority.channel_grant") {
        const row = await channelGrantMatch(reader, request);
        const parsed = Actor.ChannelGrant.safeParse(
          row === undefined ? undefined : canonicalChannelGrant(row),
        );
        return {
          kind: request.kind,
          grant: parsed.success ? parsed.data : null,
          ...sourceRefs(row),
        };
      }
      const attemptRow = await reader.attemptByRunId(request.target.runId);
      const attempt = activeAttempt(attemptRow, request.target);
      const rows = attempt === undefined ? [] : await reader.workerAttemptGrants(attempt.attemptId);
      const grants =
        attempt === undefined
          ? []
          : rows.flatMap((row) => {
              const grant = exactWorkerAttemptGrant(row, attempt);
              return grant === undefined ? [] : [{ row, grant }];
            });
      const winner = grants.length === 1 ? grants[0] : undefined;
      return {
        kind: request.kind,
        grant: winner?.grant ?? null,
        ...sourceRefs(winner?.row ?? attemptRow),
      };
    },
  });
}

export function createMessagingAccessServices(
  dependencies: MessagingAccessDependenciesV1,
): MessagingAccessServicesV1 {
  return Object.freeze({
    messaging: createMessagingLedgerService(dependencies),
    authority: createAuthorityProjectionQueryPort(dependencies.projections),
  });
}
