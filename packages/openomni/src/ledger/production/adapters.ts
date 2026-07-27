import { createHash } from "node:crypto";
import { AppConnector, Execution, Ledger, Wait } from "@openomni/protocol";
import type {
  ScheduleNativeCommand,
  ScheduleProjectionV1,
  ScheduleQuery,
} from "../../execution-runtime/schedule-service.js";
import { CONFIGURATION_OPERATION_CATALOG_V1, nativeTransitionById } from "../native-transitions.js";
import {
  bindAuthoritativeSessionLedgerRuntime,
  type AuthoritativeAppendOptionsV1,
  type KernelLedgerIncidentSinkV1,
  type SessionLedgerRuntimePortV1,
} from "../ports.js";
import { crossOwnerDestinationRequestId } from "../transitions/route-dispatch.js";
import { createKernelLedgerRuntime, KernelLedgerRuntime } from "../runtime.js";
import type { ProductionKernelStructuralPorts } from "../production-services.js";

export interface ProductionStructuralCompositionV1 {
  readonly queries: import("../ports.js").KernelQueryPortV1;
  readonly structural: ProductionKernelStructuralPorts;
}
import type {
  MessagingAccessCommitResultV1,
  MessagingAccessSnapshotBlobV1,
  ProjectionSourceV1,
} from "./messaging-access.js";
import type {
  AttemptExecutionRowV1,
  EffectRowV1,
  MessageRecoveryRowV1,
  ProductionScheduleEffectDependencies,
} from "./schedule-effect.js";
import type {
  ActiveWorkerBindingV1,
  ConnectorStartEffectProofV1,
  CredentialProvisioningAttemptRowV1,
  CredentialProvisioningAuthorizationRowV1,
  ProductionConnectorDependencies,
  ProductionProvisioningDependencies,
  WorkerAttemptRowV1,
  WorkerEffectBindingV1,
} from "./worker-connector.js";
import type {
  CompletionRecordV1,
  EffectRecordV1,
  WaitRecordV1,
  WorkAttemptRecordV1,
  WorkRecordV1,
  WorkWaitCommitV1,
} from "./work-wait.js";

type IdentitySeedV1 = Pick<
  Execution.AuthenticatedWorkerIdentityV1,
  "runtimeId" | "workerId" | "generation" | "principalId"
>;

export interface ProductionStructuralAdapterOptionsV1 {
  readonly identity: IdentitySeedV1;
  readonly clock: { now(): number };
  readonly incidentSink: KernelLedgerIncidentSinkV1;
  readonly credentialRefs?: readonly Execution.CredentialSourceRefV1[];
}

type JsonRecord = Readonly<Record<string, unknown>>;
type Artifact = Readonly<{ bytes: Uint8Array; ref: Execution.ContentBlobRefV1 }>;
type ScheduleEffectsPort = ProductionScheduleEffectDependencies["effects"];
type ScheduleRecoveryPort = ProductionScheduleEffectDependencies["recovery"];
type ConnectorLifecyclePort = ProductionConnectorDependencies["lifecycle"];
type ConnectorArtifactPort = ProductionConnectorDependencies["artifacts"];
type ProvisioningTransitionPort = ProductionProvisioningDependencies["transitions"];

type CommandContext = Readonly<{
  sessionId: string;
  runId: string;
  attemptId: string;
}>;

function record(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} projection is malformed`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0)
    throw new TypeError(`${key} projection field is malformed`);
  return field;
}

function optionalString(value: JsonRecord, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string") throw new TypeError(`${key} projection field is malformed`);
  return field;
}

function numberField(value: JsonRecord, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new TypeError(`${key} projection field is malformed`);
  }
  return field;
}

function stringList(value: JsonRecord, key: string): readonly string[] {
  const field = value[key];
  if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) {
    throw new TypeError(`${key} projection field is malformed`);
  }
  return Object.freeze([...field]);
}

function contentBlobRef(value: unknown, name: string): Execution.ContentBlobRefV1 {
  const parsed = Execution.ContentBlobRefV1.safeParse(value);
  if (!parsed.success) throw new TypeError(`${name} projection field is malformed`);
  return parsed.data;
}

function nullableContentBlobRef(value: unknown, name: string): Execution.ContentBlobRefV1 | null {
  if (value === null) return null;
  return contentBlobRef(value, name);
}

function contentBlobRefList(value: unknown, name: string): readonly Execution.ContentBlobRefV1[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} projection field is malformed`);
  return Object.freeze(value.map((item) => contentBlobRef(item, name)));
}

function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function blob(value: unknown, mediaType = "application/json"): Artifact {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  return Object.freeze({
    bytes,
    ref: Object.freeze({
      version: "content-blob-ref-v1",
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      mediaType,
    }),
  });
}

function projectionBlob(family: string, state: unknown): Artifact {
  return blob({ version: `${family}-projection-state-v1`, state });
}

function effectProjectionBlob(effect: EffectRecordV1, scope: Execution.EffectScopeV1): Artifact {
  return projectionBlob("effect", {
    ...effect,
    scope,
    workspaceId: scope.workspace.workspaceId,
  });
}

function owner(ownerKey: string): Ledger.OwnerV1 {
  return Ledger.OwnerV1.parse({ version: "ledger-owner-v1", ownerKey });
}

function sourceProjection<T extends ProjectionSourceV1>(row: T): T {
  record(row.state, "source");
  return row;
}

function parseWork(
  row: Readonly<{ workItemId: string; sessionId: string; state: unknown }>,
): WorkRecordV1 {
  const state = record(row.state, "work");
  const status = stringField(state, "status");
  if (!["draft", "running", "failed", "cancelled", "completed", "archived"].includes(status)) {
    throw new TypeError("work status projection is malformed");
  }
  return {
    workItemId: row.workItemId,
    sessionId: row.sessionId,
    title: stringField(state, "title"),
    status:
      status === "draft" ||
      status === "running" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "completed"
        ? status
        : "archived",
    evidenceRefs: stringList(state, "evidenceRefs"),
    readbackRefs: stringList(state, "readbackRefs"),
    ...(Array.isArray(state.activeBlockerRefs)
      ? { activeBlockerRefs: stringList(state, "activeBlockerRefs") }
      : {}),
  };
}

function parseConnectorSettlement(
  value: unknown,
): import("./worker-connector.js").ConnectorAttemptSettlementResultV1 | undefined {
  if (value === undefined) return undefined;
  const settlement = record(value, "connector settlement");
  const status = stringField(settlement, "status");
  if (status === "succeeded") {
    return Object.freeze({ status, result: Execution.Result.parse(settlement.result) });
  }
  if (status === "failed") {
    return Object.freeze({ status, error: stringField(settlement, "error") });
  }
  throw new TypeError("connector settlement projection is malformed");
}

function parseAttempt(
  row: Readonly<{ attemptId: string; workItemId: string; sessionId: string; state: unknown }>,
): WorkAttemptRecordV1 {
  const state = record(row.state, "attempt");
  const status = stringField(state, "status");
  if (
    ![
      "allocated",
      "starting",
      "running",
      "waiting",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(status)
  ) {
    throw new TypeError("attempt status projection is malformed");
  }
  const model = record(state.model, "attempt model");
  const environment = Execution.LLMEnvironmentV1.parse(state.environment);
  return {
    workItemId: row.workItemId,
    attemptId: row.attemptId,
    attemptSeq: numberField(state, "attemptSeq"),
    sessionId: row.sessionId,
    runId: stringField(state, "runId"),
    status:
      status === "allocated" ||
      status === "starting" ||
      status === "running" ||
      status === "waiting" ||
      status === "succeeded" ||
      status === "failed" ||
      status === "cancelled"
        ? status
        : "interrupted",
    title: stringField(state, "title"),
    prompt: stringField(state, "prompt"),
    agentName: stringField(state, "agentName"),
    ...(Array.isArray(state.acceptanceCriteria)
      ? { acceptanceCriteria: stringList(state, "acceptanceCriteria") }
      : {}),
    ...(Array.isArray(state.constraints) ? { constraints: stringList(state, "constraints") } : {}),
    model: { provider: stringField(model, "provider"), id: stringField(model, "id") },
    environment,
    ...(optionalString(state, "error") === undefined
      ? {}
      : { error: optionalString(state, "error") }),
    ...(optionalString(state, "connectorExecutionClaimId") === undefined
      ? {}
      : { connectorExecutionClaimId: optionalString(state, "connectorExecutionClaimId") }),
    ...(state.connectorSettlement === undefined
      ? {}
      : { connectorSettlement: parseConnectorSettlement(state.connectorSettlement) }),
    ...(optionalString(state, "deliveryPayload") === undefined
      ? {}
      : { deliveryPayload: optionalString(state, "deliveryPayload") }),
    ...(state.binding === undefined ? {} : { binding: parseRuntimeBinding(state.binding) }),
  };
}

function parseRuntimeBinding(value: unknown): NonNullable<WorkAttemptRecordV1["binding"]> {
  const binding = record(value, "worker runtime binding");
  return {
    runtimeId: stringField(binding, "runtimeId"),
    workerId: stringField(binding, "workerId"),
    generation: numberField(binding, "generation"),
    principalId: stringField(binding, "principalId"),
    processId: numberField(binding, "processId"),
  };
}

function parseWait(
  row: Readonly<{
    waitId: string;
    workItemId: string;
    attemptId: string;
    sessionId: string;
    state: unknown;
  }>,
): WaitRecordV1 {
  const state = record(row.state, "wait");
  const opened = Wait.OpenedV1.parse(state.opened);
  const status = stringField(state, "status");
  if (!["open", "resolved", "cancelled", "expired"].includes(status))
    throw new TypeError("wait status projection is malformed");
  const responsesValue = state.responses;
  const ambiguitiesValue = state.ambiguities;
  if (!Array.isArray(responsesValue) || !Array.isArray(ambiguitiesValue))
    throw new TypeError("wait response projection is malformed");
  const responses = responsesValue.map((item) => {
    const response = record(item, "wait response");
    const eventId = stringField(response, "eventId");
    const wireResponse = Object.fromEntries(
      Object.entries(response).filter(([key]) => key !== "eventId"),
    );
    return { ...Wait.ResponseRecordedV1.parse(wireResponse), eventId };
  });
  const ambiguities = ambiguitiesValue.map((item) => Wait.AmbiguityRecordedV1.parse(item));
  const route = record(state.route, "wait route");
  const routeKind = stringField(route, "kind");
  if (routeKind !== "worker" && routeKind !== "resident")
    throw new TypeError("wait route projection is malformed");
  const parsedRoute =
    routeKind === "worker"
      ? {
          kind: "worker" as const,
          sessionId: optionalString(route, "sessionId") ?? row.sessionId,
          runId: stringField(route, "runId"),
        }
      : {
          kind: "resident" as const,
          sessionId: optionalString(route, "sessionId") ?? row.sessionId,
          ...(optionalString(route, "runId") === undefined
            ? {}
            : { runId: optionalString(route, "runId") }),
        };
  const resolved = state.resolved === undefined ? undefined : Wait.ResolvedV1.parse(state.resolved);
  const routedAction =
    state.routedAction === undefined ? undefined : Wait.AllowedActionV1.parse(state.routedAction);
  return {
    waitId: row.waitId,
    revision: stringField(state, "revision"),
    opened,
    status:
      status === "open" || status === "resolved" || status === "cancelled" ? status : "expired",
    route: parsedRoute,
    workItemId: row.workItemId,
    attemptId: row.attemptId,
    sessionId: row.sessionId,
    ...(optionalString(state, "sourceRunId") === undefined
      ? {}
      : { sourceRunId: optionalString(state, "sourceRunId") }),
    ...(optionalString(state, "targetSessionId") === undefined
      ? {}
      : { targetSessionId: optionalString(state, "targetSessionId") }),
    ...(optionalString(state, "payloadDigest") === undefined
      ? {}
      : { payloadDigest: optionalString(state, "payloadDigest") }),
    responses,
    ambiguities,
    ...(resolved === undefined ? {} : { resolved }),
    ...(typeof state.resolvedAtDbMs === "number"
      ? { resolvedAtDbMs: numberField(state, "resolvedAtDbMs") }
      : {}),
    ...(typeof state.routingDeadlineDbMs === "number"
      ? { routingDeadlineDbMs: numberField(state, "routingDeadlineDbMs") }
      : {}),
    ...(optionalString(state, "routedDispatchId") === undefined
      ? {}
      : { routedDispatchId: optionalString(state, "routedDispatchId") }),
    ...(routedAction === undefined ? {} : { routedAction }),
  };
}

function parseEffectRecord(
  row: Readonly<{ effectId: string; workItemId: string; attemptId: string; state: unknown }>,
): EffectRecordV1 {
  const state = record(row.state, "effect");
  const attempt = Ledger.AttemptRefV1.parse(state.attempt);
  const settlement = stringField(state, "settlement");
  const operation = stringField(state, "operation");
  if (!["pending", "confirmed", "definite_failed", "unknown"].includes(settlement))
    throw new TypeError("effect settlement projection is malformed");
  if (
    ![
      "coordinator.spawn.v1",
      "coordinator.message.v1",
      "coordinator.cancel.v1",
      "worker.credential_provision.v1",
      "attempt.delivery.v1",
    ].includes(operation)
  )
    throw new TypeError("effect operation projection is malformed");
  return {
    effectId: row.effectId,
    sourceRef: stringField(state, "sourceRef"),
    workItemId: row.workItemId,
    attemptId: row.attemptId,
    attempt,
    settlement:
      settlement === "pending" || settlement === "confirmed" || settlement === "definite_failed"
        ? settlement
        : "unknown",
    operation:
      operation === "coordinator.spawn.v1" ||
      operation === "coordinator.message.v1" ||
      operation === "coordinator.cancel.v1" ||
      operation === "worker.credential_provision.v1"
        ? operation
        : "attempt.delivery.v1",
  };
}

function parseCompletion(
  row: Readonly<{ workItemId: string; state: unknown }>,
): CompletionRecordV1 {
  const state = record(row.state, "completion");
  const status = stringField(state, "status");
  if (status !== "candidate" && status !== "rejected" && status !== "admitted")
    throw new TypeError("completion status projection is malformed");
  const decision = state.decisionRef;
  if (decision !== null && typeof decision !== "string")
    throw new TypeError("completion decision projection is malformed");
  return {
    workItemId: row.workItemId,
    status,
    candidateRef: stringField(state, "candidateRef"),
    verdictRefs: stringList(state, "verdictRefs"),
    decisionRef: typeof decision === "string" ? decision : null,
    stakesAsOfLedgerSeq: numberField(state, "stakesAsOfLedgerSeq"),
    stakesAsOfDbMs: numberField(state, "stakesAsOfDbMs"),
  };
}

function contextForAttempt(attempt: WorkAttemptRecordV1): CommandContext {
  return { sessionId: attempt.sessionId, runId: attempt.runId, attemptId: attempt.attemptId };
}

function attemptRef(attempt: WorkAttemptRecordV1): Ledger.AttemptRefV1 {
  return {
    version: "attempt-ref-v1",
    workItemId: attempt.workItemId,
    attemptId: attempt.attemptId,
    attemptSeq: attempt.attemptSeq,
  };
}

export function createProductionKernelStructuralPorts(
  runtime: SessionLedgerRuntimePortV1,
  options: ProductionStructuralAdapterOptionsV1,
): ProductionStructuralCompositionV1 {
  const authoritative = bindAuthoritativeSessionLedgerRuntime(runtime);
  const kernelProjection = Object.freeze({
    async query(request: Execution.KernelQueryV1): Promise<Execution.KernelQueryResultV1> {
      if (request.kind === "authenticated_transcript") {
        const rows = await runtime.query((capability) =>
          capability.messagesBySession(request.sessionId),
        );
        const messages = rows.map((row) => {
          const state = record(row.state, "message");
          const role = stringField(state, "role");
          if (role !== "user" && role !== "assistant")
            throw new TypeError("authenticated transcript role is malformed");
          const parts = state.parts;
          if (!Array.isArray(parts))
            throw new TypeError("authenticated transcript parts are malformed");
          const content = parts
            .map((part) => optionalString(record(part, "message part"), "text") ?? "")
            .join("");
          return { role, content };
        });
        return Execution.KernelQueryResultV1.parse({
          version: "kernel-query-result-v1",
          kind: request.kind,
          messages,
        });
      }
      if (request.kind === "authenticated_attempt") {
        const row = await runtime.query((capability) =>
          capability.attempt(request.attempt.attemptId),
        );
        if (row === undefined || row.workItemId !== request.attempt.workItemId)
          throw new Error("authenticated Attempt projection not found");
        const attempt = parseAttempt(row);
        if (attempt.attemptSeq !== request.attempt.attemptSeq)
          throw new Error("authenticated Attempt projection mismatch");
        const attemptOwner = owner(`work:${attempt.workItemId}`);
        const head = await runtime.query((capability) => capability.head(attemptOwner));
        const events =
          head.ownerSeq === 0
            ? []
            : await runtime.query((capability) =>
                capability.eventsByOwnerSequence(attemptOwner, {
                  throughOwnerSeq: head.ownerSeq,
                  limit: head.ownerSeq,
                }),
              );
        const dispatchIds = new Set(
          events.flatMap(({ event }) =>
            typeof event.payload.dispatchId === "string" ? [event.payload.dispatchId] : [],
          ),
        );
        const destinationOwners = new Map<string, Ledger.OwnerV1>();
        for (const { event } of events) {
          const parsedOwner = Ledger.OwnerV1.safeParse(event.payload.destinationOwner);
          if (parsedOwner.success && parsedOwner.data.ownerKey !== attemptOwner.ownerKey) {
            destinationOwners.set(parsedOwner.data.ownerKey, parsedOwner.data);
          }
        }
        const destinationEvents = (
          await Promise.all(
            [...destinationOwners.values()].map(async (destinationOwner) => {
              const destinationHead = await runtime.query((capability) =>
                capability.head(destinationOwner),
              );
              if (destinationHead.ownerSeq === 0) return [];
              return runtime.query((capability) =>
                capability.eventsByOwnerSequence(destinationOwner, {
                  throughOwnerSeq: destinationHead.ownerSeq,
                  limit: destinationHead.ownerSeq,
                }),
              );
            }),
          )
        )
          .flat()
          .filter(
            ({ event }) =>
              typeof event.payload.dispatchId === "string" &&
              dispatchIds.has(event.payload.dispatchId),
          );
        const correlatedEvents = [...events, ...destinationEvents].sort(
          (left, right) => left.ledgerSeq - right.ledgerSeq,
        );
        return Execution.KernelQueryResultV1.parse({
          version: "kernel-query-result-v1",
          kind: request.kind,
          attempt: request.attempt,
          events: correlatedEvents,
          environment: Execution.RedactedEnvironmentRefV1.parse(attempt.environment),
        });
      }
      const row = await runtime.query((capability) => capability.wait(request.waitId));
      if (row === undefined) throw new Error("authenticated Wait projection not found");
      const wait = parseWait(row);
      return Execution.KernelQueryResultV1.parse({
        version: "kernel-query-result-v1",
        kind: request.kind,
        wait: wait.resolved ?? wait.opened,
      });
    },
  });
  const pendingArtifacts = new Map<string, readonly Artifact[]>();
  const writer = Object.freeze({
    findReceipt: authoritative.writer.findReceipt,
    readHead: authoritative.writer.readHead,
    appendBatch(
      request: Ledger.AppendBatchRequestV1,
      appendOptions?: AuthoritativeAppendOptionsV1,
    ) {
      const supplied = pendingArtifacts.get(request.requestId) ?? [];
      return authoritative.writer.appendBatch(request, {
        artifactBlobs: [
          ...(appendOptions?.artifactBlobs ?? []),
          ...supplied.map((artifact) => ({
            bytes: artifact.bytes,
            expectedHash: `sha256:${artifact.ref.digest}` as const,
          })),
        ],
      });
    },
  });
  const kernel = createKernelLedgerRuntime({
    writer,
    ownerEvents: authoritative.ownerEvents,
    projections: kernelProjection,
    incidentSink: options.incidentSink,
    readDefiniteDispatchFailureProof: async (request) => {
      const pending = [...pendingArtifacts.values()]
        .flat()
        .find(
          (artifact) =>
            artifact.ref.digest === request.proofRef.digest &&
            artifact.ref.byteLength === request.proofRef.byteLength,
        );
      if (pending !== undefined) {
        if (
          pending.bytes.byteLength !== request.proofRef.byteLength ||
          createHash("sha256").update(pending.bytes).digest("hex") !== request.proofRef.digest
        ) {
          throw new TypeError("Pending definite dispatch failure proof reference is invalid");
        }
        return Object.freeze({ ref: request.proofRef, bytes: pending.bytes });
      }
      const stored = await authoritative.blobs.readBlob(`sha256:${request.proofRef.digest}`);
      if (stored === undefined) return undefined;
      if (
        stored.hash !== `sha256:${request.proofRef.digest}` ||
        stored.size !== request.proofRef.byteLength ||
        stored.bytes.byteLength !== request.proofRef.byteLength ||
        createHash("sha256").update(stored.bytes).digest("hex") !== request.proofRef.digest
      ) {
        throw new TypeError("Definite dispatch failure proof blob reference is invalid");
      }
      return Object.freeze({ ref: request.proofRef, bytes: stored.bytes });
    },
  });

  const execute = async (
    transitionId: string,
    ownerKey: string,
    facts: Readonly<Record<string, unknown>>,
    requestId: string,
    artifacts: readonly Artifact[],
    context: CommandContext,
  ) => {
    const catalog = nativeTransitionById(transitionId);
    const transitionOwner = owner(ownerKey);
    const expectedHead = await authoritative.writer.readHead(transitionOwner);
    const payload = {
      version: "native-transition-payload-v1",
      transitionId,
      command: catalog.command,
      owner: transitionOwner,
      facts,
    } as const;
    const command = {
      version: "kernel-transition-command-v1",
      transitionId,
      command: catalog.command,
      requestId,
      requestHash: digest({ requestId, payload, principalId: options.identity.principalId }),
      identity: {
        version: "authenticated-worker-identity-v1",
        ...options.identity,
        sessionId: context.sessionId,
        runId: context.runId,
        attemptId: context.attemptId,
      },
      expectedHead,
      payload,
    } as const;
    const artifactRequestId =
      transitionId === "XD-01"
        ? crossOwnerDestinationRequestId({
            sourceOwnerKey: ownerKey,
            dispatchId: stringField(record(facts.DP, "XD-01 DP facts"), "subjectId"),
          })
        : transitionId === "XD-02" || transitionId === "XD-03"
          ? `${requestId}:settlement`
          : requestId;
    pendingArtifacts.set(artifactRequestId, artifacts);
    try {
      return await KernelLedgerRuntime.prototype.execute.call(kernel, command);
    } finally {
      pendingArtifacts.delete(artifactRequestId);
    }
  };

  const reconcileDispatchFacts = async (
    sourceOwnerKey: string,
    requestId: string,
    receipt: Ledger.AppendReceiptV1,
    facts: Record<string, unknown>,
  ): Promise<void> => {
    if (
      receipt.owner.ownerKey !== sourceOwnerKey ||
      receipt.principalId !== options.identity.principalId
    ) {
      throw new TypeError("Authoritative dispatch source receipt identity is malformed");
    }
    const sourceOwner = owner(sourceOwnerKey);
    const sourceHead = await authoritative.writer.readHead(sourceOwner);
    const sourceEvents = await authoritative.ownerEvents.readOwnerEvents(
      sourceOwner,
      sourceHead.ownerSeq,
    );
    const pending = sourceEvents.find(
      ({ event }) =>
        receipt.eventIds.includes(event.eventId) &&
        event.eventType === "dispatch.pending.v1" &&
        event.provenance.requestId === requestId,
    );
    if (pending === undefined) {
      throw new TypeError("Authoritative dispatch pending event is missing");
    }
    const payload = record(pending.event.payload, "authoritative dispatch pending event");
    const dispatchFact = {
      subjectId: stringField(payload, "subjectId"),
      occurredAtDbMs: numberField(payload, "occurredAtDbMs"),
      dispatchId: stringField(payload, "dispatchId"),
      routeId: stringField(payload, "routeId"),
      sourceSessionId: stringField(payload, "sourceSessionId"),
      sourceOwner: Ledger.OwnerV1.parse(payload.sourceOwner),
      destinationOwner: Ledger.OwnerV1.parse(payload.destinationOwner),
      dispatchDecision: stringField(payload, "dispatchDecision"),
      settlement: stringField(payload, "settlement"),
      dispatchSnapshotRef: Execution.ContentBlobRefV1.parse(payload.dispatchSnapshotRef),
      destinationReceiptRef: nullableContentBlobRef(
        payload.destinationReceiptRef,
        "destinationReceiptRef",
      ),
      definiteFailureProofRef: nullableContentBlobRef(
        payload.definiteFailureProofRef,
        "definiteFailureProofRef",
      ),
    };
    facts.DP = dispatchFact;
    if (facts.EF !== undefined) {
      facts.EF = {
        ...record(facts.EF, "DP-12 EF facts"),
        occurredAtDbMs: dispatchFact.occurredAtDbMs,
      };
    }
  };

  const commitMessaging = async (
    transitionId: string,
    payload: Readonly<Record<string, unknown>>,
    artifacts: readonly MessagingAccessSnapshotBlobV1[],
    requestId: string,
  ): Promise<MessagingAccessCommitResultV1> => {
    const ownerValue = Ledger.OwnerV1.parse(payload.owner);
    const rawFacts =
      payload.projections === undefined
        ? { [transitionId.slice(0, 2)]: payload }
        : record(payload.projections, "messaging projections");
    const factsValue = Object.fromEntries(
      Object.entries(rawFacts).map(([family, fact]) => [
        family,
        Object.fromEntries(
          Object.entries(record(fact, `${family} messaging fact`)).filter(
            ([key]) => key !== "owner" && key !== "projections",
          ),
        ),
      ]),
    );
    const normalizedArtifacts: Artifact[] = [...artifacts];
    const effectFactValue = factsValue.EF;
    if (effectFactValue !== undefined) {
      const effectFact = record(effectFactValue, "EF messaging fact");
      const attempt = Ledger.AttemptRefV1.parse(effectFact.attempt);
      const effectRef = Ledger.EffectRefV1.parse(effectFact.effect);
      const settlementRef = Execution.ContentBlobRefV1.parse(effectFact.effectSettlementRef);
      const effectScope = Execution.EffectScopeV1.parse(effectFact.effectScope);
      const artifactIndex = normalizedArtifacts.findIndex(
        (artifact) => artifact.ref.digest === settlementRef.digest,
      );
      const originalArtifact = normalizedArtifacts[artifactIndex];
      if (originalArtifact === undefined)
        throw new TypeError("EF messaging snapshot artifact is missing");
      const decoded: unknown = JSON.parse(new TextDecoder().decode(originalArtifact.bytes));
      const envelope = record(decoded, "EF messaging snapshot");
      const state = record(envelope.state, "EF messaging snapshot state");
      const normalized = blob({
        version: stringField(envelope, "version"),
        state: {
          ...state,
          effectId: effectRef.effectId,
          workspaceId: effectScope.workspace.workspaceId,
          workItemId: attempt.workItemId,
          attemptId: attempt.attemptId,
        },
      });
      normalizedArtifacts[artifactIndex] = normalized;
      factsValue.EF = {
        ...effectFact,
        effectScopeRef: normalized.ref,
        effectSettlementRef: normalized.ref,
      };
    }
    const sessionId =
      typeof payload.sessionId === "string" ? payload.sessionId : ownerValue.ownerKey;
    const result = await execute(
      transitionId,
      ownerValue.ownerKey,
      factsValue,
      requestId,
      normalizedArtifacts,
      {
        sessionId,
        runId: typeof payload.messageId === "string" ? payload.messageId : requestId,
        attemptId: typeof payload.messageId === "string" ? payload.messageId : requestId,
      },
    );
    if (result.status === "committed") {
      return {
        status: "committed",
        receiptId: result.receipt.eventIds[0] ?? result.receipt.requestId,
      };
    }
    return {
      status: "rejected",
      code: result.code === "identity_mismatch" ? "transition_forbidden" : result.code,
    };
  };

  const workWaitCommit = async (command: WorkWaitCommitV1) => {
    const occurredAtDbMs = options.clock.now();
    const isWorkerControl =
      command.transitionId === "DP-12" ||
      command.transitionId === "DP-13" ||
      command.transitionId === "DP-14";
    const isEffectSettlement =
      command.transitionId === "EF-01" ||
      command.transitionId === "EF-02" ||
      command.transitionId === "EF-03";
    const includesAttemptFacts =
      Execution.NativeTransitionFactFamiliesV1[command.transitionId].includes("AT");
    const isContextOnly = isWorkerControl || isEffectSettlement;
    const skipWorkFacts = isContextOnly || command.transitionId === "DP-07";
    const artifacts: Artifact[] = [];
    const facts: Record<string, unknown> = {};
    let context: CommandContext;
    let ownerKey: string;
    if ("attempt" in command) {
      context = contextForAttempt(command.attempt);
      ownerKey = `work:${command.attempt.workItemId}`;
      if (includesAttemptFacts) {
        const attemptBlob = projectionBlob("attempt", command.attempt);
        const environmentBlob = blob(command.attempt.environment);
        artifacts.push(attemptBlob, environmentBlob);
        facts.AT = {
          subjectId: command.attempt.attemptId,
          occurredAtDbMs,
          attempt: attemptRef(command.attempt),
          runBinding: {
            version: "run-binding-v1",
            workItemId: command.attempt.workItemId,
            attemptId: command.attempt.attemptId,
            sessionId: command.attempt.sessionId,
            runId: command.attempt.runId,
          },
          model: command.attempt.model,
          environmentRef: Execution.RedactedEnvironmentRefV1.parse(command.attempt.environment),
          environmentSnapshotRef: environmentBlob.ref,
          attemptSnapshotRef: attemptBlob.ref,
        };
      }
    } else if ("wait" in command) {
      context = {
        sessionId: command.wait.sessionId,
        runId: command.wait.sourceRunId ?? command.wait.attemptId,
        attemptId: command.wait.attemptId,
      };
      ownerKey = `work:${command.wait.workItemId}`;
    } else if ("work" in command) {
      if ("completion" in command) {
        const projectedCompletion = await runtime.query((q) =>
          q.completion(command.completion.candidateRef),
        );
        if (projectedCompletion === undefined)
          throw new TypeError("Authoritative completion projection is missing");
        const projectedState = record(projectedCompletion.state, "completion context");
        context = {
          sessionId: stringField(projectedState, "sessionId"),
          runId: stringField(projectedState, "runId"),
          attemptId: stringField(projectedState, "attemptId"),
        };
        ownerKey = projectedCompletion.ownerKey;
      } else {
        context = {
          sessionId: command.work.sessionId,
          runId: command.work.workItemId,
          attemptId: command.work.workItemId,
        };
        ownerKey = `work:${command.work.workItemId}`;
      }
    } else {
      const projectedCompletion = await runtime.query((q) =>
        q.completion(command.completion.candidateRef),
      );
      if (projectedCompletion === undefined) {
        context = {
          sessionId: command.completion.workItemId,
          runId: command.completion.workItemId,
          attemptId: command.completion.workItemId,
        };
      } else {
        const projectedState = record(projectedCompletion.state, "completion context");
        context = {
          sessionId: stringField(projectedState, "sessionId"),
          runId: stringField(projectedState, "runId"),
          attemptId: stringField(projectedState, "attemptId"),
        };
      }
      ownerKey = projectedCompletion?.ownerKey ?? `work:${command.completion.workItemId}`;
    }
    if ("work" in command && !skipWorkFacts) {
      const workBlob = projectionBlob("work", { ...command.work, id: command.work.workItemId });
      artifacts.push(workBlob);
      facts.WI = {
        subjectId: command.work.workItemId,
        occurredAtDbMs,
        workItemId: command.work.workItemId,
        sessionId: command.work.sessionId,
        workSnapshotRef: workBlob.ref,
      };
    }
    if ("completion" in command) {
      const candidate =
        "candidate" in command
          ? command.candidate
          : "verdict" in command
            ? command.verdict.candidate
            : command.decision.candidate;
      const candidateArtifact = blob(candidate);
      if (candidateArtifact.ref.digest !== command.completion.candidateRef) {
        throw new TypeError("Completion candidate artifact does not match its immutable ID");
      }
      const priorCompletion = await runtime.query((query) =>
        query.completion(command.completion.candidateRef),
      );
      const priorArtifactRefs =
        priorCompletion === undefined
          ? []
          : contentBlobRefList(
              record(priorCompletion.state, "completion artifact refs").verdictArtifactRefs,
              "verdictArtifactRefs",
            );
      const verdictCommand = "verdict" in command && "verdictRef" in command ? command : undefined;
      const verdictArtifact =
        verdictCommand === undefined ? undefined : blob(verdictCommand.verdict);
      if (
        verdictArtifact !== undefined &&
        (verdictArtifact.ref.digest !== verdictCommand?.verdictRef ||
          priorArtifactRefs.some((ref) => ref.digest === verdictArtifact.ref.digest))
      ) {
        throw new TypeError("Completion claim verdict artifact is not exact and immutable");
      }
      const verdictArtifactRefs = Object.freeze([
        ...priorArtifactRefs,
        ...(verdictArtifact === undefined ? [] : [verdictArtifact.ref]),
      ]);
      if (
        command.completion.verdictRefs.length !== verdictArtifactRefs.length ||
        command.completion.verdictRefs.some(
          (ref, index) => ref !== verdictArtifactRefs[index]?.digest,
        )
      ) {
        throw new TypeError("Completion verdict projection does not match authoritative artifacts");
      }
      const decisionCommand =
        "decision" in command && "decisionRef" in command ? command : undefined;
      const admissionDecisionArtifact =
        decisionCommand === undefined ? undefined : blob(decisionCommand.decision);
      if (
        admissionDecisionArtifact !== undefined &&
        (admissionDecisionArtifact.ref.digest !== decisionCommand?.decisionRef ||
          decisionCommand.decision.verdictRefs.length !== verdictArtifactRefs.length ||
          decisionCommand.decision.verdictRefs.some(
            (ref: string, index: number) => ref !== verdictArtifactRefs[index]?.digest,
          ))
      ) {
        throw new TypeError("Completion admission decision artifact is not canonical");
      }
      if (
        "candidate" in command &&
        (command.completion.status !== "candidate" ||
          command.completion.verdictRefs.length !== 0 ||
          command.completion.decisionRef !== null)
      ) {
        throw new TypeError("Completion candidate construction has terminal semantic refs");
      }
      if (
        verdictCommand !== undefined &&
        (command.completion.status !== "candidate" || command.completion.decisionRef !== null)
      ) {
        throw new TypeError("Completion verdict construction is not an active candidate");
      }
      if (
        decisionCommand !== undefined &&
        (command.completion.status !== "admitted" ||
          command.completion.decisionRef !== admissionDecisionArtifact?.ref.digest)
      ) {
        throw new TypeError("Completion admission construction lacks its exact decision identity");
      }
      const completionState = {
        ...command.completion,
        candidateId: command.completion.candidateRef,
        attemptId: context.attemptId,
        sessionId: context.sessionId,
        runId: context.runId,
        candidateArtifactRef: candidateArtifact.ref,
        verdictArtifactRefs,
        verdictArtifactRef: verdictArtifact?.ref ?? null,
        admissionDecisionArtifactRef: admissionDecisionArtifact?.ref ?? null,
      };
      const completionBlob = projectionBlob("completion", completionState);
      const runBindingBlob = blob(context);
      artifacts.push(
        completionBlob,
        runBindingBlob,
        candidateArtifact,
        ...(verdictArtifact === undefined ? [] : [verdictArtifact]),
        ...(admissionDecisionArtifact === undefined ? [] : [admissionDecisionArtifact]),
      );
      facts.CP = {
        subjectId: command.completion.workItemId,
        occurredAtDbMs,
        workItemId: command.completion.workItemId,
        candidateId: command.completion.candidateRef,
        runBinding: {
          version: "run-binding-v1",
          workItemId: command.completion.workItemId,
          attemptId: context.attemptId,
          sessionId: context.sessionId,
          runId: context.runId,
        },
        runBindingRef: runBindingBlob.ref,
        completionSnapshotRef: completionBlob.ref,
        candidateArtifactRef: candidateArtifact.ref,
        verdictArtifactRef: verdictArtifact?.ref ?? null,
        admissionDecisionArtifactRef: admissionDecisionArtifact?.ref ?? null,
        verdictArtifactRefs,
      };
    }
    if ("wait" in command) {
      const waitBlob = projectionBlob("wait", command.wait);
      artifacts.push(waitBlob);
      const event =
        "waitResume" in command
          ? command.waitResume
          : "event" in command
            ? command.event
            : command.wait.opened;
      facts.WT = {
        subjectId: command.wait.waitId,
        occurredAtDbMs,
        waitEvent: event,
        waitSnapshotRef: waitBlob.ref,
      };
      if (command.transitionId === "WT-03") {
        const dispatchId = command.wait.routedDispatchId ?? `wait:${command.wait.waitId}:threshold`;
        const dispatchBlob = projectionBlob("dispatch", {
          dispatchId,
          routeId: dispatchId,
          sourceSessionId: command.wait.sessionId,
          sourceOwner: owner(ownerKey),
          destinationOwner: owner(ownerKey),
          decision: "accepted",
          settlement: "pending",
          destinationReceiptRef: null,
          definiteFailureProofRef: null,
        });
        artifacts.push(dispatchBlob);
        facts.DP = {
          subjectId: dispatchId,
          occurredAtDbMs,
          dispatchId,
          routeId: dispatchId,
          sourceSessionId: command.wait.sessionId,
          sourceOwner: owner(ownerKey),
          destinationOwner: owner(ownerKey),
          dispatchDecision: "accepted",
          settlement: "pending",
          dispatchSnapshotRef: dispatchBlob.ref,
          destinationReceiptRef: null,
          definiteFailureProofRef: null,
        };
      }
    }
    if (command.transitionId === "AT-12") {
      if (command.waitResume === undefined)
        throw new TypeError("AT-12 requires an authoritative Wait resume projection");
      const waitResume = command.waitResume;
      const waitRow = await runtime.query((query) => query.wait(waitResume.waitId));
      if (waitRow === undefined)
        throw new TypeError("AT-12 authoritative Wait projection is missing");
      const wait = parseWait(waitRow);
      if (wait.status !== "resolved")
        throw new TypeError("AT-12 authoritative Wait is not resolved");
      const waitBlob = projectionBlob("wait", wait);
      artifacts.push(waitBlob);
      delete facts.AT;
      facts.WT = {
        subjectId: wait.waitId,
        occurredAtDbMs,
        waitEvent: waitResume,
        waitSnapshotRef: waitBlob.ref,
      };
    }
    let commandEffect = "effect" in command ? command.effect : undefined;
    let authoritativeEffectScope: Execution.EffectScopeV1 | undefined;
    let authoritativeEffectProjection: Readonly<{ ownerKey: string; state: unknown }> | undefined;
    const maySettleAttemptDelivery =
      command.transitionId === "AT-03" || command.transitionId === "AT-13";
    if (maySettleAttemptDelivery && "attempt" in command) {
      const attemptId = command.attempt.attemptId;
      const attemptRow = await runtime.query((q) => q.attempt(attemptId));
      if (attemptRow === undefined)
        throw new TypeError("Authoritative Attempt projection is missing");
      const currentAttempt = parseAttempt(attemptRow);
      if (currentAttempt.status === "waiting") {
        if (commandEffect === undefined) {
          throw new TypeError("Attempt delivery settlement requires its exact effect binding");
        }
        const exactCommandEffect = commandEffect;
        const effectProjection = await runtime.query((q) => q.effect(exactCommandEffect.effectId));
        if (effectProjection === undefined)
          throw new TypeError("Authoritative Attempt delivery effect projection is missing");
        const effect = parseEffectRecord(effectProjection);
        if (
          effect.effectId !== exactCommandEffect.effectId ||
          effect.sourceRef !== exactCommandEffect.sourceRef ||
          effect.workItemId !== currentAttempt.workItemId ||
          effect.attemptId !== currentAttempt.attemptId ||
          effect.attempt.workItemId !== currentAttempt.workItemId ||
          effect.attempt.attemptId !== currentAttempt.attemptId ||
          effect.attempt.attemptSeq !== currentAttempt.attemptSeq ||
          effect.operation !== "coordinator.message.v1" ||
          effect.settlement !== "pending"
        ) {
          throw new TypeError("Authoritative Attempt delivery effect is not pending and exact");
        }
        commandEffect = {
          ...effect,
          settlement: command.transitionId === "AT-03" ? "confirmed" : "definite_failed",
        };
        authoritativeEffectScope = Execution.EffectScopeV1.parse(
          record(effectProjection.state, "Attempt delivery effect").scope,
        );
        authoritativeEffectProjection = effectProjection;
      } else if (command.transitionId === "AT-13") {
        throw new TypeError("AT-13 delivery settlement requires a waiting Attempt");
      }
    }
    if (commandEffect !== undefined) {
      const effectToCommit = commandEffect;
      const effectScope =
        authoritativeEffectScope ??
        ("effectScope" in command ? command.effectScope : internalEffectScope(effectToCommit));
      const effectBlob = effectProjectionBlob(effectToCommit, effectScope);
      artifacts.push(effectBlob);
      facts.EF = effectFacts(effectToCommit, effectBlob, occurredAtDbMs, effectScope);
      if (isEffectSettlement || authoritativeEffectProjection !== undefined) {
        const effectProjection =
          authoritativeEffectProjection ??
          (await runtime.query((q) => q.effect(effectToCommit.effectId)));
        if (effectProjection === undefined)
          throw new TypeError("Authoritative effect projection is missing");
        ownerKey = effectProjection.ownerKey;
        const effectOwner = owner(ownerKey);
        const head = await runtime.query((q) => q.head(effectOwner));
        const ownerEvents =
          head.ownerSeq === 0
            ? []
            : await runtime.query((q) =>
                q.eventsByOwnerSequence(effectOwner, {
                  throughOwnerSeq: head.ownerSeq,
                  limit: head.ownerSeq,
                }),
              );
        const intent = ownerEvents.find(
          ({ event }) =>
            event.eventType === "effect.intent.v1" &&
            event.payload.effectId === effectToCommit.effectId &&
            event.payload.idempotencyKey === effectToCommit.sourceRef,
        );
        if (intent === undefined) throw new TypeError("Authoritative effect intent is missing");
        const effectFact = record(facts.EF, "effect settlement fact");
        facts.EF = {
          ...effectFact,
          effectScopeRef: Execution.ContentBlobRefV1.parse(intent.event.payload.effectScopeRef),
        };
      }
    }
    if (command.transitionId.startsWith("DP-")) {
      const dispatch = "dispatch" in command ? command.dispatch : undefined;
      const dispatchId =
        command.transitionId === "DP-15"
          ? command.dispatchId
          : dispatch !== undefined
            ? dispatch.dispatchId
            : command.requestId;
      const sourceSessionId =
        "attempt" in command
          ? command.attempt.sessionId
          : "work" in command
            ? command.work.sessionId
            : context.sessionId;
      const destinationOwner =
        command.transitionId === "DP-12" && dispatch !== undefined && "sessionId" in dispatch
          ? owner(`session:${dispatch.sessionId}`)
          : command.transitionId === "DP-15" && command.wait.targetSessionId !== undefined
            ? owner(`session:${command.wait.targetSessionId}`)
            : owner(ownerKey);
      const settlement = "pending" as const;
      const dispatchState = {
        dispatchId,
        routeId: dispatchId,
        sourceSessionId,
        sourceOwner: ownerKey,
        destinationOwner: destinationOwner.ownerKey,
        settlement,
        destinationReceiptRef: null,
        definiteFailureProofRef: null,
      };
      const dispatchBlob = projectionBlob("dispatch", dispatchState);
      artifacts.push(dispatchBlob);
      facts.DP = {
        subjectId: dispatchId,
        occurredAtDbMs,
        dispatchId,
        routeId: dispatchId,
        sourceSessionId,
        sourceOwner: owner(ownerKey),
        destinationOwner,
        dispatchDecision: "accepted",
        settlement,
        dispatchSnapshotRef: dispatchBlob.ref,
        destinationReceiptRef: null,
        definiteFailureProofRef: null,
      };
    }
    if (command.transitionId === "DP-12") {
      const priorSourceReceipt = await authoritative.writer.findReceipt(command.requestId);
      if (priorSourceReceipt !== null) {
        await reconcileDispatchFacts(ownerKey, command.requestId, priorSourceReceipt, facts);
      }
    }
    let result = await execute(
      command.transitionId,
      ownerKey,
      facts,
      command.requestId,
      artifacts,
      context,
    );
    if (command.transitionId === "DP-12" && result.status === "committed") {
      await reconcileDispatchFacts(ownerKey, command.requestId, result.receipt, facts);
      result = await execute(
        "XD-01",
        ownerKey,
        facts,
        `${command.requestId}:destination`,
        artifacts,
        context,
      );
      if (result.status === "committed") {
        const destinationReceiptArtifact = blob(result.receipt);
        const pendingDispatchFact = record(facts.DP, "pending cross-owner dispatch facts");
        const settledDispatchState = {
          dispatchId: stringField(pendingDispatchFact, "dispatchId"),
          routeId: stringField(pendingDispatchFact, "routeId"),
          sourceSessionId: stringField(pendingDispatchFact, "sourceSessionId"),
          sourceOwner: Ledger.OwnerV1.parse(pendingDispatchFact.sourceOwner).ownerKey,
          destinationOwner: Ledger.OwnerV1.parse(pendingDispatchFact.destinationOwner).ownerKey,
          settlement: "delivered" as const,
          destinationReceiptRef: destinationReceiptArtifact.ref,
          definiteFailureProofRef: null,
        };
        const settledDispatchBlob = projectionBlob("dispatch", settledDispatchState);
        const settledDispatchFact = {
          ...pendingDispatchFact,
          occurredAtDbMs: numberField(pendingDispatchFact, "occurredAtDbMs"),
          settlement: "delivered" as const,
          dispatchSnapshotRef: settledDispatchBlob.ref,
          destinationReceiptRef: destinationReceiptArtifact.ref,
          definiteFailureProofRef: null,
        };
        result = await execute(
          "XD-02",
          ownerKey,
          { DP: settledDispatchFact },
          command.requestId,
          [destinationReceiptArtifact, settledDispatchBlob],
          context,
        );
      }
      if (
        result.status === "rejected" &&
        result.definiteFailureClass === "destination_append_definite_no_materialization"
      ) {
        const pendingDispatchFact = record(facts.DP, "pending cross-owner dispatch facts");
        const dispatchId = stringField(pendingDispatchFact, "dispatchId");
        const destinationOwner = Ledger.OwnerV1.parse(pendingDispatchFact.destinationOwner);
        const destinationRequestId = crossOwnerDestinationRequestId({
          sourceOwnerKey: ownerKey,
          dispatchId,
        });
        const destinationHead = await authoritative.writer.readHead(destinationOwner);
        const destinationReceipt = await authoritative.writer.findReceipt(destinationRequestId);
        if (destinationReceipt === null) {
          const definiteFailureProof = blob({
            version: "definite-dispatch-failure-proof-v1",
            sourceOwnerKey: ownerKey,
            dispatchId,
            destinationOwnerKey: destinationOwner.ownerKey,
            destinationRequestId,
            destinationHead,
            destinationState: "absent",
            failureClass: "destination_append_definite_no_materialization",
          });
          const settledDispatchState = {
            dispatchId,
            routeId: stringField(pendingDispatchFact, "routeId"),
            sourceSessionId: stringField(pendingDispatchFact, "sourceSessionId"),
            sourceOwner: Ledger.OwnerV1.parse(pendingDispatchFact.sourceOwner).ownerKey,
            destinationOwner: destinationOwner.ownerKey,
            settlement: "definite_failed" as const,
            destinationReceiptRef: null,
            definiteFailureProofRef: definiteFailureProof.ref,
          };
          const settledDispatchBlob = projectionBlob("dispatch", settledDispatchState);
          const settledDispatchFact = {
            ...pendingDispatchFact,
            occurredAtDbMs: numberField(pendingDispatchFact, "occurredAtDbMs"),
            settlement: "definite_failed" as const,
            dispatchSnapshotRef: settledDispatchBlob.ref,
            destinationReceiptRef: null,
            definiteFailureProofRef: definiteFailureProof.ref,
          };
          result = await execute(
            "XD-03",
            ownerKey,
            { DP: settledDispatchFact },
            command.requestId,
            [definiteFailureProof, settledDispatchBlob],
            context,
          );
        }
      }
    }
    const effectBinding =
      commandEffect === undefined
        ? undefined
        : {
            effect: {
              version: "effect-ref-v1" as const,
              effectId: commandEffect.effectId,
              idempotencyKey: commandEffect.sourceRef,
            },
            effectScope:
              "effectScope" in command ? command.effectScope : internalEffectScope(commandEffect),
          };
    return {
      transitionResult: result,
      ...(effectBinding === undefined ? {} : { effectBinding }),
    };
  };

  const scheduleExecute = async (command: ScheduleNativeCommand) => {
    const scheduleId =
      command.transitionId === "DP-23" ? command.schedule.scheduleId : command.scheduleId;
    const prior = await runtime.query((capability) => capability.schedule(scheduleId));
    const priorState = prior === undefined ? undefined : parseSchedule(prior);
    const snapshot = scheduleSnapshot(command, priorState);
    const snapshotBlob = projectionBlob("schedule", snapshot);
    const facts: Record<string, unknown> = {
      SC: {
        subjectId: scheduleId,
        occurredAtDbMs: options.clock.now(),
        scheduleId,
        generation: snapshot.generation,
        nextFireRef: snapshot.nextFireRef,
        settlementRef: snapshot.settledFireRef ?? null,
        scheduleSnapshotRef: snapshotBlob.ref,
      },
    };
    if (command.transitionId.startsWith("DP-") || command.transitionId === "RT-17") {
      const dispatchId = `schedule:${scheduleId}:${snapshot.generation}`;
      const dispatchBlob = projectionBlob("dispatch", {
        dispatchId,
        scheduleId,
        generation: snapshot.generation,
        destinationReceiptRef: null,
        definiteFailureProofRef: null,
      });
      artifactsPush(
        facts,
        command.transitionId,
        dispatchId,
        command.ownerKey,
        snapshot,
        dispatchBlob,
        options.clock.now(),
      );
      const result = await execute(
        command.transitionId,
        command.ownerKey,
        facts,
        command.requestId,
        [snapshotBlob, dispatchBlob],
        {
          sessionId: snapshot.target.sessionId ?? scheduleId,
          runId: dispatchId,
          attemptId: dispatchId,
        },
      );
      return result.status === "committed"
        ? { status: "committed" as const, snapshot }
        : result.code === "head_conflict"
          ? { status: "conflict" as const }
          : { status: "rejected" as const, code: result.code };
    }
    const result = await execute(
      command.transitionId,
      command.ownerKey,
      facts,
      command.requestId,
      [snapshotBlob],
      {
        sessionId: snapshot.target.sessionId ?? scheduleId,
        runId: scheduleId,
        attemptId: scheduleId,
      },
    );
    return result.status === "committed"
      ? { status: "committed" as const, snapshot }
      : result.code === "head_conflict"
        ? { status: "conflict" as const }
        : { status: "rejected" as const, code: result.code };
  };

  const structural: ProductionKernelStructuralPorts = Object.freeze({
    messagingAccess: Object.freeze({
      transitions: Object.freeze({ commit: commitMessaging }),
      projections: Object.freeze({
        session: (id: string) =>
          runtime
            .query((q) => q.session(id))
            .then((row) => (row === undefined ? undefined : sourceProjection(row))),
        surfaceBinding: (id: string) =>
          runtime
            .query((q) => q.surfaceBinding(id))
            .then((row) => (row === undefined ? undefined : sourceProjection(row))),
        messagesBySession: (id: string) =>
          runtime.query((q) => q.messagesBySession(id)).then((rows) => rows.map(sourceProjection)),
        actorIdentity: (id: string) =>
          runtime
            .query((q) => q.actorIdentity(id))
            .then((row) => (row === undefined ? undefined : sourceProjection(row))),
        actorEndpoint: (id: string) =>
          runtime
            .query((q) => q.actorEndpoint(id))
            .then((row) => (row === undefined ? undefined : sourceProjection(row))),
        blocklistEntries: () =>
          runtime.query((q) => q.blacklistEntries()).then((rows) => rows.map(sourceProjection)),
        channelGrant: (id: string) =>
          runtime
            .query((q) => q.channelGrant(id))
            .then((row) => (row === undefined ? undefined : sourceProjection(row))),
        attemptByRunId: (id: string) =>
          runtime
            .query((q) => q.attemptByRunId(id))
            .then((row) => (row === undefined ? undefined : sourceProjection(row))),
        workerAttemptGrants: (id: string) =>
          runtime
            .query((q) => q.workerGrantsByAttempt(id))
            .then((rows) => rows.map(sourceProjection)),
        effect: (id: string) =>
          runtime
            .query((q) => q.effect(id))
            .then((row) => (row === undefined ? undefined : sourceProjection(row))),
      }),
    }),
    workWait: Object.freeze({
      projections: Object.freeze({
        work: (id: string) =>
          runtime
            .query((q) => q.work(id))
            .then((row) => (row === undefined ? undefined : parseWork(row))),
        completion: (id: string) =>
          runtime
            .query((q) => q.completionsByWork(id))
            .then((rows) => {
              const row = rows.at(-1);
              return row === undefined ? undefined : parseCompletion(row);
            }),
        attempt: (id: string) =>
          runtime
            .query((q) => q.attempt(id))
            .then((row) => (row === undefined ? undefined : parseAttempt(row))),
        attemptByRunId: (id: string) =>
          runtime
            .query((q) => q.attemptByRunId(id))
            .then((row) => (row === undefined ? undefined : parseAttempt(row))),
        attemptsBySession: (id: string) =>
          runtime.query((q) => q.attemptsBySession(id)).then((rows) => rows.map(parseAttempt)),
        wait: (id: string) =>
          runtime
            .query((q) => q.wait(id))
            .then((row) => (row === undefined ? undefined : parseWait(row))),
        waitCandidates: (endpointId?: string, channelId?: string) =>
          runtime
            .query((q) => q.waitCandidates(endpointId, channelId))
            .then((rows) => rows.map(parseWait)),
        waitsByAttempt: (attemptId: string) =>
          runtime.query((q) => q.waitsByAttempt(attemptId)).then((rows) => rows.map(parseWait)),
        effect: (id: string) =>
          runtime
            .query((q) => q.effect(id))
            .then((row) => (row === undefined ? undefined : parseEffectRecord(row))),
      }),
      transitions: Object.freeze({ commit: workWaitCommit }),
    }),
    scheduleEffect: Object.freeze({
      schedule: Object.freeze({
        execute: scheduleExecute,
        async query(request: ScheduleQuery) {
          if (request.kind === "schedule_by_id") {
            const row = await runtime.query((q) => q.schedule(request.scheduleId));
            return { kind: request.kind, snapshot: row === undefined ? null : parseSchedule(row) };
          }
          const rows = await runtime.query((q) => q.dueSchedules(request.atMs, request.limit));
          return { kind: request.kind, snapshots: rows.map(parseSchedule) };
        },
      }),
      queries: Object.freeze({
        effect: (id: string) =>
          runtime
            .query((q) => q.effect(id))
            .then((row) => (row === undefined ? undefined : parseScheduleEffect(row))),
        attemptByRunId: (id: string) =>
          runtime
            .query((q) => q.attemptByRunId(id))
            .then((row) => (row === undefined ? undefined : parseAttemptExecution(row))),
        interruptedAttempts: () =>
          runtime
            .query((q) => q.interruptedAttempts())
            .then((rows) => rows.map(parseAttemptExecution)),
        interruptedMessages: () =>
          runtime
            .query((q) => q.interruptedMessages())
            .then((rows) => rows.map(parseRecoveryMessage)),
        message: (id: string) =>
          runtime
            .query((q) => q.message(id))
            .then((row) => (row === undefined ? undefined : parseRecoveryMessage(row))),
      }),
      effects: Object.freeze({
        recordIntent: async (input: Parameters<ScheduleEffectsPort["recordIntent"]>[0]) =>
          effectTransition(
            input.transitionId,
            input.ownerKey,
            input.attempt,
            input.effectId,
            input.sourceRef,
            input.scope,
            "pending",
            input.requestId,
            input.sessionId,
            input.environment,
            execute,
            options.clock.now(),
          ),
        recordSettlement: async (input: Parameters<ScheduleEffectsPort["recordSettlement"]>[0]) =>
          effectTransition(
            input.transitionId,
            input.ownerKey,
            input.attempt,
            input.effectId,
            input.sourceRef,
            input.scope,
            input.settlement,
            input.requestId,
            input.attempt.workItemId,
            undefined,
            execute,
            options.clock.now(),
          ),
      }),
      recovery: Object.freeze({
        interruptAttempt: async (input: Parameters<ScheduleRecoveryPort["interruptAttempt"]>[0]) =>
          simpleAttemptTransition(
            input.transitionId,
            input.attempt,
            input.requestId,
            runtime,
            execute,
            options.clock.now(),
          ),
        failStreamingMessage: async (
          input: Parameters<ScheduleRecoveryPort["failStreamingMessage"]>[0],
        ) => {
          const messageState = {
            id: input.messageId,
            sessionId: input.sessionId,
            status: "failed",
            surfaceId: input.surfaceId,
            role: input.role,
            model: input.model,
            parts: [],
          };
          const messageBlob = projectionBlob("message", messageState);
          const facts = {
            MS: {
              subjectId: input.messageId,
              occurredAtDbMs: options.clock.now(),
              sessionId: input.sessionId,
              surfaceId: input.surfaceId,
              messageId: input.messageId,
              partId: null,
              role: input.role,
              status: "failed",
              model: input.model,
              messageSnapshotRef: messageBlob.ref,
              partSnapshotRef: null,
            },
          };
          const result = await execute(
            input.transitionId,
            input.ownerKey,
            facts,
            input.requestId,
            [messageBlob],
            { sessionId: input.sessionId, runId: input.messageId, attemptId: input.messageId },
          );
          return result.status === "committed" ? "committed" : "conflict";
        },
      }),
    }),
    workerConnector: createWorkerConnectorPorts(
      runtime,
      options,
      kernel,
      kernelProjection,
      execute,
      pendingArtifacts,
    ),
    views: Object.freeze({
      openWorks: () => runtime.query((q) => q.openWorks()).then((rows) => rows.map(parseWork)),
      attemptsByWork: (workItemId: string) =>
        runtime.query((q) => q.attemptsByWork(workItemId)).then((rows) => rows.map(parseAttempt)),
      attemptsBySession: (sessionId: string) =>
        runtime.query((q) => q.attemptsBySession(sessionId)).then((rows) => rows.map(parseAttempt)),
      async sessionEvents(sessionId: string) {
        const sessionOwner = owner(`session:${sessionId}`);
        const head = await runtime.query((q) => q.head(sessionOwner));
        if (head.ownerSeq === 0) return [];
        return runtime.query((q) =>
          q.eventsByOwnerSequence(sessionOwner, {
            throughOwnerSeq: head.ownerSeq,
            limit: head.ownerSeq,
          }),
        );
      },
    }),
  });
  return Object.freeze({ queries: kernel, structural });
}

function effectFacts(
  effect: EffectRecordV1,
  artifact: Artifact,
  occurredAtDbMs: number,
  authoritativeScope?: Execution.EffectScopeV1,
) {
  const scope = authoritativeScope ?? internalEffectScope(effect);
  return {
    subjectId: effect.effectId,
    occurredAtDbMs,
    effect: {
      version: "effect-ref-v1",
      effectId: effect.effectId,
      idempotencyKey: effect.sourceRef,
    },
    attempt: effect.attempt,
    effectScope: scope,
    effectScopeRef: artifact.ref,
    settlement: effect.settlement,
    effectSettlementRef: artifact.ref,
  };
}

function internalEffectScope(effect: EffectRecordV1): Execution.EffectScopeV1 {
  const sourceDigest = createHash("sha256").update(effect.sourceRef).digest("hex");
  const workItemDigest = createHash("sha256").update(effect.workItemId).digest("hex");
  return Execution.EffectScopeV1.parse({
    version: "effect-scope-v1",
    workspace: {
      canonicalizerVersion: "workspace-v1",
      workspaceId: `w1:${workItemDigest}`,
      canonicalBytesDigest: workItemDigest,
    },
    resources: [
      {
        version: "resource-scope-v1",
        kind: "registered",
        variant: "kernel_effect.v1",
        targetDigest: sourceDigest,
      },
    ],
    resolver: { id: "production-structural-adapter", version: "1", inputDigest: sourceDigest },
    containment: "none",
    mutationClass: "mutating",
  });
}

function parseSchedule(
  row: Readonly<{
    scheduleId: string;
    ownerKey: string;
    state: unknown;
    sourceEventId: string;
    sourceOwnerSeq: number;
    sourceLedgerSeq: number;
    sourceOwnerHash: string;
    asOfLedgerSeq: number;
  }>,
): ScheduleProjectionV1 {
  const state = record(row.state, "schedule");
  const target = record(state.target, "schedule target");
  const kind = stringField(target, "kind");
  if (kind !== "resident" && kind !== "worker")
    throw new TypeError("schedule target projection is malformed");
  const status = stringField(state, "status");
  if (status !== "active" && status !== "paused" && status !== "cancelled")
    throw new TypeError("schedule status projection is malformed");
  const nextFireAtDbMs = state.nextFireAtDbMs;
  const nextFireRef = state.nextFireRef;
  if (nextFireAtDbMs !== null && typeof nextFireAtDbMs !== "number")
    throw new TypeError("schedule next fire projection is malformed");
  if (nextFireRef !== null && typeof nextFireRef !== "string")
    throw new TypeError("schedule next fire projection is malformed");
  return {
    scheduleId: row.scheduleId,
    agentName: stringField(state, "agentName"),
    target: {
      kind,
      ...(optionalString(target, "sessionId") === undefined
        ? {}
        : { sessionId: optionalString(target, "sessionId") }),
    },
    expression: stringField(state, "expression"),
    payloadRef: stringField(state, "payloadRef"),
    ownerKey: row.ownerKey,
    status,
    generation: numberField(state, "generation"),
    nextFireAtDbMs: typeof nextFireAtDbMs === "number" ? nextFireAtDbMs : null,
    nextFireRef: typeof nextFireRef === "string" ? nextFireRef : null,
    ...(optionalString(state, "pendingFireRef") === undefined
      ? {}
      : { pendingFireRef: optionalString(state, "pendingFireRef") }),
    ...(optionalString(state, "settledFireRef") === undefined
      ? {}
      : { settledFireRef: optionalString(state, "settledFireRef") }),
    sourceEventId: row.sourceEventId,
    sourceOwnerSeq: row.sourceOwnerSeq,
    sourceLedgerSeq: row.sourceLedgerSeq,
    sourceOwnerHash: row.sourceOwnerHash,
    asOfLedgerSeq: row.asOfLedgerSeq,
  };
}

function scheduleSnapshot(
  command: ScheduleNativeCommand,
  prior: ScheduleProjectionV1 | undefined,
): ScheduleProjectionV1 {
  if (command.transitionId === "DP-23")
    return {
      ...command.schedule,
      ownerKey: command.ownerKey,
      status: "active",
      generation: 0,
      nextFireAtDbMs: command.nextFireAtDbMs,
      nextFireRef: command.nextFireRef,
      sourceEventId: command.requestId,
      sourceOwnerSeq: 0,
      sourceLedgerSeq: 0,
      sourceOwnerHash: "GENESIS_V1",
      asOfLedgerSeq: 0,
    };
  if (prior === undefined || prior.sourceOwnerHash !== command.expectedSourceOwnerHash)
    throw new Error("authoritative schedule projection mismatch");
  if (command.transitionId === "DP-24")
    return { ...prior, status: "cancelled", nextFireAtDbMs: null, nextFireRef: null };
  if (command.transitionId === "RT-17")
    return { ...prior, generation: command.generation, pendingFireRef: command.fireRef };
  if (command.transitionId === "SC-02") return { ...prior, settledFireRef: command.fireRef };
  return {
    ...prior,
    generation: command.generation,
    nextFireAtDbMs: command.nextFireAtDbMs,
    nextFireRef: command.nextFireRef,
  };
}

function artifactsPush(
  facts: Record<string, unknown>,
  transitionId: string,
  dispatchId: string,
  ownerKey: string,
  schedule: ScheduleProjectionV1,
  dispatchBlob: Artifact,
  now: number,
): void {
  const dp = {
    subjectId: dispatchId,
    occurredAtDbMs: now,
    dispatchId,
    routeId: dispatchId,
    sourceSessionId: schedule.target.sessionId ?? schedule.scheduleId,
    sourceOwner: owner(ownerKey),
    destinationOwner: owner(ownerKey),
    dispatchDecision: "accepted",
    settlement: transitionId === "DP-24" ? "definite_failed" : "pending",
    dispatchSnapshotRef: dispatchBlob.ref,
    destinationReceiptRef: null,
    definiteFailureProofRef: null,
  };
  facts.DP = dp;
  if (transitionId === "RT-17")
    facts.RT = {
      subjectId: dispatchId,
      occurredAtDbMs: now,
      sessionId: schedule.target.sessionId ?? schedule.scheduleId,
      surfaceId: "schedule",
      messageId: dispatchId,
      routeId: dispatchId,
      routeDecision: "accepted",
      authoritySnapshotRef: dispatchBlob.ref,
      routeSnapshotRef: dispatchBlob.ref,
    };
}

function parseAttemptExecution(
  row: Readonly<{
    ownerKey: string;
    attemptId: string;
    workItemId: string;
    sessionId: string;
    state: unknown;
    sourceEventId: string;
  }>,
): AttemptExecutionRowV1 {
  const attempt = parseAttempt(row);
  return {
    ownerKey: row.ownerKey,
    workItemId: row.workItemId,
    attemptId: row.attemptId,
    sessionId: row.sessionId,
    sourceEventId: row.sourceEventId,
    state: {
      runId: attempt.runId,
      attemptSeq: attempt.attemptSeq,
      status: attempt.status,
      environment: attempt.environment,
    },
  };
}

function parseScheduleEffect(
  row: Readonly<{
    ownerKey: string;
    effectId: string;
    workItemId: string;
    attemptId: string;
    state: unknown;
    sourceEventId: string;
  }>,
): EffectRowV1 {
  const state = record(row.state, "effect");
  const settlement = stringField(state, "settlement");
  if (
    !["pending", "confirmed", "definite_failed", "unknown", "manually_resolved"].includes(
      settlement,
    )
  )
    throw new TypeError("effect settlement projection is malformed");
  return {
    ownerKey: row.ownerKey,
    workItemId: row.workItemId,
    attemptId: row.attemptId,
    sourceEventId: row.sourceEventId,
    state: {
      effectId: row.effectId,
      sourceRef: stringField(state, "sourceRef"),
      operation: "connector.submit.v1",
      settlement:
        settlement === "pending" ||
        settlement === "confirmed" ||
        settlement === "definite_failed" ||
        settlement === "unknown"
          ? settlement
          : "manually_resolved",
      attempt: Ledger.AttemptRefV1.parse(state.attempt),
      scope: Execution.EffectScopeV1.parse(state.scope ?? state.effectScope),
    },
  };
}

function parseRecoveryMessage(
  row: Readonly<{ ownerKey: string; messageId: string; sessionId: string; state: unknown }>,
): MessageRecoveryRowV1 {
  const state = record(row.state, "message");
  return {
    ownerKey: row.ownerKey,
    sessionId: row.sessionId,
    messageId: row.messageId,
    state: {
      status: stringField(state, "status"),
      ...(optionalString(state, "surfaceId") === undefined
        ? {}
        : { surfaceId: optionalString(state, "surfaceId") }),
      ...(optionalString(state, "role") === undefined
        ? {}
        : { role: optionalString(state, "role") }),
      ...(state.model === undefined ? {} : { model: state.model }),
    },
  };
}

async function effectTransition(
  transitionId: string,
  ownerKey: string,
  attempt: Ledger.AttemptRefV1,
  effectId: string,
  sourceRef: string,
  scope: Execution.EffectScopeV1,
  settlement: string,
  requestId: string,
  sessionId: string,
  environment: Execution.LLMEnvironmentV1 | undefined,
  execute: (
    transitionId: string,
    ownerKey: string,
    facts: Readonly<Record<string, unknown>>,
    requestId: string,
    artifacts: readonly Artifact[],
    context: CommandContext,
  ) => Promise<Execution.KernelTransitionResultV1>,
  now: number,
) {
  const state = {
    effectId,
    sourceRef,
    operation: "connector.submit.v1",
    settlement,
    attempt,
    scope,
  };
  const effectBlob = projectionBlob("effect", {
    ...state,
    workspaceId: scope.workspace.workspaceId,
    workItemId: attempt.workItemId,
    attemptId: attempt.attemptId,
  });
  const facts: Record<string, unknown> = {
    EF: {
      subjectId: effectId,
      occurredAtDbMs: now,
      effect: { version: "effect-ref-v1", effectId, idempotencyKey: sourceRef },
      attempt,
      effectScope: scope,
      effectScopeRef: effectBlob.ref,
      settlement,
      effectSettlementRef: effectBlob.ref,
    },
  };
  if (transitionId === "DP-06") {
    if (environment === undefined) throw new Error("connector intent environment is missing");
    const dispatchBlob = projectionBlob("dispatch", {
      dispatchId: sourceRef,
      effectId,
      settlement: "pending",
      destinationReceiptRef: null,
      definiteFailureProofRef: null,
    });
    facts.DP = {
      subjectId: sourceRef,
      occurredAtDbMs: now,
      dispatchId: sourceRef,
      routeId: sourceRef,
      sourceSessionId: sessionId,
      sourceOwner: owner(ownerKey),
      destinationOwner: owner(ownerKey),
      dispatchDecision: "accepted",
      settlement: "pending",
      dispatchSnapshotRef: dispatchBlob.ref,
      destinationReceiptRef: null,
      definiteFailureProofRef: null,
    };
    const result = await execute(
      transitionId,
      ownerKey,
      facts,
      requestId,
      [effectBlob, dispatchBlob],
      { sessionId, runId: attempt.attemptId, attemptId: attempt.attemptId },
    );
    if (result.status !== "committed")
      throw new Error(`effect transition rejected: ${result.code}`);
    return { receiptId: result.receipt.eventIds[0] ?? result.receipt.requestId };
  }
  const result = await execute(transitionId, ownerKey, facts, requestId, [effectBlob], {
    sessionId,
    runId: attempt.attemptId,
    attemptId: attempt.attemptId,
  });
  if (result.status !== "committed") throw new Error(`effect transition rejected: ${result.code}`);
  return { receiptId: result.receipt.eventIds[0] ?? result.receipt.requestId };
}

async function simpleAttemptTransition(
  transitionId: string,
  attempt: Ledger.AttemptRefV1,
  requestId: string,
  runtime: SessionLedgerRuntimePortV1,
  execute: (
    transitionId: string,
    ownerKey: string,
    facts: Readonly<Record<string, unknown>>,
    requestId: string,
    artifacts: readonly Artifact[],
    context: CommandContext,
  ) => Promise<Execution.KernelTransitionResultV1>,
  now: number,
): Promise<"committed" | "conflict"> {
  const row = await runtime.query((q) => q.attempt(attempt.attemptId));
  if (row === undefined) return "conflict";
  const state = parseAttempt(row);
  const next = {
    ...state,
    status: transitionId === "AT-03" ? ("running" as const) : ("interrupted" as const),
  };
  const attemptBlob = projectionBlob("attempt", next);
  const environmentBlob = blob(next.environment);
  const artifacts: Artifact[] = [attemptBlob, environmentBlob];
  const facts: Record<string, unknown> = {
    AT: {
      subjectId: attempt.attemptId,
      occurredAtDbMs: now,
      attempt,
      runBinding: {
        version: "run-binding-v1",
        workItemId: attempt.workItemId,
        attemptId: attempt.attemptId,
        sessionId: next.sessionId,
        runId: next.runId,
      },
      model: next.model,
      environmentRef: Execution.RedactedEnvironmentRefV1.parse(next.environment),
      environmentSnapshotRef: environmentBlob.ref,
      attemptSnapshotRef: attemptBlob.ref,
    },
  };
  if (transitionId === "AT-03") {
    const effectId = `credential-provisioning:${attempt.attemptId}`;
    const effectRow = await runtime.query((q) => q.effect(effectId));
    if (effectRow === undefined) return "conflict";
    const effectState = record(effectRow.state, "credential provisioning effect");
    const projectedAttempt = Ledger.AttemptRefV1.parse(effectState.attempt);
    if (
      projectedAttempt.workItemId !== attempt.workItemId ||
      projectedAttempt.attemptId !== attempt.attemptId ||
      projectedAttempt.attemptSeq !== attempt.attemptSeq ||
      stringField(effectState, "settlement") !== "pending"
    )
      return "conflict";
    const sourceRef = stringField(effectState, "sourceRef");
    const scope = Execution.EffectScopeV1.parse(effectState.scope ?? effectState.effectScope);
    const attemptOwner = owner(`work:${attempt.workItemId}`);
    const head = await runtime.query((q) => q.head(attemptOwner));
    const ownerEvents =
      head.ownerSeq === 0
        ? []
        : await runtime.query((q) =>
            q.eventsByOwnerSequence(attemptOwner, {
              throughOwnerSeq: head.ownerSeq,
              limit: head.ownerSeq,
            }),
          );
    const intent = ownerEvents.find(
      ({ event }) =>
        event.eventType === "effect.intent.v1" &&
        event.payload.effectId === effectId &&
        event.payload.idempotencyKey === sourceRef,
    );
    if (intent === undefined) return "conflict";
    const effectScopeRef = Execution.ContentBlobRefV1.parse(intent.event.payload.effectScopeRef);
    const effectBlob = projectionBlob("effect", {
      ...effectState,
      settlement: "confirmed",
      scope,
      workspaceId: scope.workspace.workspaceId,
      workItemId: attempt.workItemId,
      attemptId: attempt.attemptId,
    });
    artifacts.push(effectBlob);
    facts.EF = {
      subjectId: effectId,
      occurredAtDbMs: now,
      effect: { version: "effect-ref-v1", effectId, idempotencyKey: sourceRef },
      attempt,
      effectScope: scope,
      effectScopeRef,
      settlement: "confirmed",
      effectSettlementRef: effectBlob.ref,
    };
  }
  const result = await execute(
    transitionId,
    `work:${attempt.workItemId}`,
    facts,
    requestId,
    artifacts,
    contextForAttempt(next),
  );
  return result.status === "committed" ? "committed" : "conflict";
}

function parseActiveBinding(
  state: JsonRecord,
  attempt: Ledger.AttemptRefV1,
  sessionId: string,
  runId: string,
): ActiveWorkerBindingV1 {
  const binding = record(state.binding, "worker binding");
  return {
    runtimeId: stringField(binding, "runtimeId"),
    workerId: stringField(binding, "workerId"),
    generation: numberField(binding, "generation"),
    principalId: stringField(binding, "principalId"),
    processId: numberField(binding, "processId"),
    sessionId,
    runId,
    attempt,
  };
}

function expectedConnectorStartProof(
  attempt: Ledger.AttemptRefV1,
  request: Execution.Request,
  installation: AppConnector.Installation,
): ConnectorStartEffectProofV1 {
  const workspaceRoot = stringField(record(request, "connector request"), "workspaceRoot");
  const workspaceDigest = createHash("sha256").update(workspaceRoot).digest("hex");
  const inputDigest = digest({
    action: "worker.spawn",
    endpointId: installation.endpointId,
    installationId: installation.id,
    connectorVersion: installation.connectorVersion,
    runId: request.runId,
    sessionId: request.sessionId,
    prompt: request.prompt,
  });
  const sourceRef = digest({
    version: "connector-start-source-v1",
    attempt,
    installationId: installation.id,
    endpointId: installation.endpointId,
    inputDigest,
  });
  return {
    effectId: `connector-effect:${sourceRef}`,
    sourceRef,
    operation: "connector.submit.v1",
    attempt,
    scope: Execution.EffectScopeV1.parse({
      version: "effect-scope-v1",
      workspace: {
        canonicalizerVersion: "workspace-v1",
        workspaceId: `w1:${workspaceDigest}`,
        canonicalBytesDigest: workspaceDigest,
      },
      resources: [
        {
          version: "resource-scope-v1",
          kind: "connector",
          installationId: installation.id,
          definitionVersion: installation.connectorVersion,
        },
        {
          version: "resource-scope-v1",
          kind: "endpoint",
          targetDigest: createHash("sha256").update(installation.endpointId).digest("hex"),
        },
      ],
      resolver: { id: "connector-installation-v1", version: "1", inputDigest },
      containment: "connector-declared",
      mutationClass: "unknown",
    }),
  };
}

function createWorkerConnectorPorts(
  runtime: SessionLedgerRuntimePortV1,
  options: ProductionStructuralAdapterOptionsV1,
  kernel: ReturnType<typeof createKernelLedgerRuntime>,
  kernelProjection: {
    query(request: Execution.KernelQueryV1): Promise<Execution.KernelQueryResultV1>;
  },
  execute: (
    transitionId: string,
    ownerKey: string,
    facts: Readonly<Record<string, unknown>>,
    requestId: string,
    artifacts: readonly Artifact[],
    context: CommandContext,
  ) => Promise<Execution.KernelTransitionResultV1>,
  pendingArtifacts: Map<string, readonly Artifact[]>,
): ProductionKernelStructuralPorts["workerConnector"] {
  const attemptRow = async (
    attemptId: string,
  ): Promise<CredentialProvisioningAttemptRowV1 | undefined> => {
    const row = await runtime.query((q) => q.attempt(attemptId));
    if (row === undefined) return undefined;
    const attempt = parseAttempt(row);
    const ref = attemptRef(attempt);
    const state = record(row.state, "attempt");
    return {
      ownerKey: row.ownerKey,
      sessionId: row.sessionId,
      runId: attempt.runId,
      status: attempt.status === "allocated" ? "starting" : attempt.status,
      attempt: ref,
      model: attempt.model,
      ...(state.binding === undefined
        ? {}
        : { binding: parseActiveBinding(state, ref, row.sessionId, attempt.runId) }),
    };
  };
  const workerAttempt = async (runId: string): Promise<WorkerAttemptRowV1 | undefined> => {
    const row = await runtime.query((q) => q.attemptByRunId(runId));
    if (row === undefined) return undefined;
    const attempt = parseAttempt(row);
    const ref = attemptRef(attempt);
    const state = record(row.state, "attempt");
    return {
      owner: owner(row.ownerKey),
      sessionId: row.sessionId,
      runId,
      status: attempt.status === "allocated" ? "starting" : attempt.status,
      attempt: ref,
      ...(state.binding === undefined
        ? {}
        : { binding: parseActiveBinding(state, ref, row.sessionId, runId) }),
    };
  };
  const authorization = async (
    effectId: string,
  ): Promise<CredentialProvisioningAuthorizationRowV1 | undefined> => {
    const row = await runtime.query((q) => q.effect(effectId));
    if (row === undefined) return undefined;
    const effect = parseScheduleEffect(row);
    return {
      ownerKey: row.ownerKey,
      effectId,
      sourceRef: effect.state.sourceRef,
      settlement: effect.state.settlement,
      attempt: effect.state.attempt,
      scope: effect.state.scope,
    };
  };
  const lifecycle = async (
    input: Readonly<{
      transitionId: string;
      ownerKey?: string;
      attempt?: Ledger.AttemptRefV1;
      sessionId?: string;
      runId?: string;
      requestId: string;
      workItemId?: string;
      name?: string;
      request?: Execution.Request;
      installation?: AppConnector.Installation;
      environment?: Execution.LLMEnvironmentV1;
      executionClaimId?: string;
      effect?: ConnectorStartEffectProofV1;
      error?: string;
      settlement?: import("./worker-connector.js").ConnectorAttemptSettlementResultV1;
    }>,
  ) => {
    const ownerKey =
      input.ownerKey ?? `work:${input.attempt?.workItemId ?? input.workItemId ?? ""}`;
    if (input.transitionId === "WI-01" || input.transitionId === "WI-02") {
      if (input.workItemId === undefined || input.sessionId === undefined)
        throw new Error("work lifecycle binding is missing");
      const state = {
        workItemId: input.workItemId,
        sessionId: input.sessionId,
        title: input.name ?? input.workItemId,
        status: input.transitionId === "WI-01" ? "draft" : "running",
        evidenceRefs: [],
        readbackRefs: [],
      };
      const workBlob = projectionBlob("work", { ...state, id: input.workItemId });
      const result = await execute(
        input.transitionId,
        ownerKey,
        {
          WI: {
            subjectId: input.workItemId,
            occurredAtDbMs: options.clock.now(),
            workItemId: input.workItemId,
            sessionId: input.sessionId,
            workSnapshotRef: workBlob.ref,
          },
        },
        input.requestId,
        [workBlob],
        { sessionId: input.sessionId, runId: input.workItemId, attemptId: input.workItemId },
      );
      if (result.status !== "committed")
        throw new Error(`connector lifecycle rejected: ${result.code}`);
      return;
    }
    if (input.attempt === undefined) throw new Error("Attempt lifecycle binding is missing");
    const authoritativeAttempt = input.attempt;
    const projected = await runtime.query((q) => q.attempt(authoritativeAttempt.attemptId));
    if (input.transitionId === "AT-01" && projected !== undefined) {
      const projectedAttempt = parseAttempt(projected);
      if (projectedAttempt.connectorExecutionClaimId !== input.executionClaimId) {
        throw new Error("connector execution claim not acquired");
      }
    }
    const current =
      projected === undefined
        ? (() => {
            if (
              input.request === undefined ||
              input.environment === undefined ||
              input.sessionId === undefined ||
              input.runId === undefined
            )
              throw new Error("Attempt allocation projection input is missing");
            return {
              workItemId: authoritativeAttempt.workItemId,
              attemptId: authoritativeAttempt.attemptId,
              attemptSeq: authoritativeAttempt.attemptSeq,
              sessionId: input.sessionId,
              runId: input.runId,
              status: "allocated" as const,
              title: input.installation?.id ?? authoritativeAttempt.attemptId,
              prompt: input.request.prompt,
              agentName: input.installation?.id ?? "connector",
              model: input.request.model,
              environment: input.environment,
              connectorExecutionClaimId: input.executionClaimId,
            };
          })()
        : parseAttempt(projected);
    const status =
      input.transitionId === "AT-02"
        ? "starting"
        : input.transitionId === "AT-03"
          ? "running"
          : input.transitionId === "AT-07"
            ? "succeeded"
            : "failed";
    const next: WorkAttemptRecordV1 = {
      ...current,
      status,
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.settlement === undefined ? {} : { connectorSettlement: input.settlement }),
    };
    const attemptBlob = projectionBlob("attempt", next);
    const environmentBlob = blob(next.environment);
    const artifacts: Artifact[] = [attemptBlob, environmentBlob];
    const occurredAtDbMs = options.clock.now();
    const facts: Record<string, unknown> = {
      AT: {
        subjectId: next.attemptId,
        occurredAtDbMs,
        attempt: authoritativeAttempt,
        runBinding: {
          version: "run-binding-v1",
          workItemId: next.workItemId,
          attemptId: next.attemptId,
          sessionId: next.sessionId,
          runId: next.runId,
        },
        model: next.model,
        environmentRef: Execution.RedactedEnvironmentRefV1.parse(next.environment),
        environmentSnapshotRef: environmentBlob.ref,
        attemptSnapshotRef: attemptBlob.ref,
      },
    };
    let committedStartEffect: ConnectorStartEffectProofV1 | undefined;
    if (input.transitionId === "AT-02") {
      if (
        input.request === undefined ||
        input.installation === undefined ||
        input.effect === undefined
      ) {
        throw new Error("connector start effect proof is missing");
      }
      const expected = expectedConnectorStartProof(
        authoritativeAttempt,
        input.request,
        input.installation,
      );
      if (canonicalJson(input.effect) !== canonicalJson(expected)) {
        throw new Error("connector start effect proof is forged");
      }
      const effectState = {
        effectId: expected.effectId,
        sourceRef: expected.sourceRef,
        operation: expected.operation,
        settlement: "pending" as const,
        attempt: authoritativeAttempt,
        scope: expected.scope,
        workspaceId: expected.scope.workspace.workspaceId,
        workItemId: authoritativeAttempt.workItemId,
        attemptId: authoritativeAttempt.attemptId,
      };
      const effectBlob = projectionBlob("effect", effectState);
      artifacts.push(effectBlob);
      facts.EF = {
        subjectId: expected.effectId,
        occurredAtDbMs,
        effect: {
          version: "effect-ref-v1",
          effectId: expected.effectId,
          idempotencyKey: expected.sourceRef,
        },
        attempt: authoritativeAttempt,
        effectScope: expected.scope,
        effectScopeRef: effectBlob.ref,
        settlement: "pending",
        effectSettlementRef: effectBlob.ref,
      };
      committedStartEffect = Object.freeze(expected);
    }
    if (input.transitionId === "AT-03") {
      if (input.effect === undefined) throw new Error("connector start effect proof is missing");
      const claimedEffect = input.effect;
      const effectProjection = await runtime.query((q) => q.effect(claimedEffect.effectId));
      if (effectProjection === undefined || effectProjection.ownerKey !== ownerKey) {
        throw new Error("connector start effect proof is not authoritative");
      }
      const authoritativeEffect = parseScheduleEffect(effectProjection);
      if (
        authoritativeEffect.state.sourceRef !== claimedEffect.sourceRef ||
        authoritativeEffect.state.operation !== "connector.submit.v1" ||
        authoritativeEffect.state.settlement !== "pending" ||
        canonicalJson(authoritativeEffect.state.attempt) !== canonicalJson(authoritativeAttempt) ||
        canonicalJson(authoritativeEffect.state.scope) !== canonicalJson(claimedEffect.scope)
      ) {
        throw new Error("connector start effect proof is not pending and exact");
      }
      const effectOwner = owner(effectProjection.ownerKey);
      const effectHead = await runtime.query((q) => q.head(effectOwner));
      const ownerEvents = await runtime.query((q) =>
        q.eventsByOwnerSequence(effectOwner, {
          throughOwnerSeq: effectHead.ownerSeq,
          limit: effectHead.ownerSeq,
        }),
      );
      const intent = ownerEvents.find(
        ({ event }) =>
          event.eventType === "effect.intent.v1" &&
          event.payload.effectId === claimedEffect.effectId &&
          event.payload.idempotencyKey === claimedEffect.sourceRef &&
          event.payload.workItemId === authoritativeAttempt.workItemId &&
          event.payload.attemptId === authoritativeAttempt.attemptId,
      );
      if (intent === undefined) throw new Error("connector start effect intent is missing");
      const settledState = {
        ...authoritativeEffect.state,
        settlement: "confirmed" as const,
        workspaceId: authoritativeEffect.state.scope.workspace.workspaceId,
        workItemId: authoritativeAttempt.workItemId,
        attemptId: authoritativeAttempt.attemptId,
      };
      const settlementBlob = projectionBlob("effect", settledState);
      artifacts.push(settlementBlob);
      facts.EF = {
        subjectId: claimedEffect.effectId,
        occurredAtDbMs,
        effect: {
          version: "effect-ref-v1",
          effectId: claimedEffect.effectId,
          idempotencyKey: claimedEffect.sourceRef,
        },
        attempt: authoritativeAttempt,
        effectScope: authoritativeEffect.state.scope,
        effectScopeRef: Execution.ContentBlobRefV1.parse(intent.event.payload.effectScopeRef),
        settlement: "confirmed",
        effectSettlementRef: settlementBlob.ref,
      };
    }
    const result = await execute(
      input.transitionId,
      ownerKey,
      facts,
      input.requestId,
      artifacts,
      contextForAttempt(next),
    );
    if (result.status !== "committed")
      throw new Error(`connector lifecycle rejected: ${result.code}`);
    return committedStartEffect;
  };

  return Object.freeze({
    worker: Object.freeze({
      queries: Object.freeze({
        attemptByRunId: workerAttempt,
        workSession: (id: string) => runtime.query((q) => q.work(id)).then((row) => row?.sessionId),
        waitIdsByAttempt: (id: string) =>
          runtime.query((q) => q.waitsByAttempt(id)).then((rows) => rows.map((row) => row.waitId)),
        effectsByAttempt: (id: string): Promise<readonly WorkerEffectBindingV1[]> =>
          runtime
            .query((q) => q.effectsByAttempt(id))
            .then((rows) =>
              rows.map((row) => {
                const effect = parseScheduleEffect(row);
                return {
                  effect: {
                    version: "effect-ref-v1",
                    effectId: row.effectId,
                    idempotencyKey: effect.state.sourceRef,
                  },
                  effectScope: effect.state.scope,
                };
              }),
            ),
        head: (value: Ledger.OwnerV1) => runtime.query((q) => q.head(value)),
      }),
      transitions: kernel,
      projections: kernelProjection,
    }),
    connector: Object.freeze({
      queries: Object.freeze({
        connectorInstallation: (id: string) =>
          runtime
            .query((q) => q.connectorInstallation(id))
            .then((row) =>
              row === undefined
                ? undefined
                : AppConnector.Installation.parse(
                    record(row.state, "connector installation").installation ?? row.state,
                  ),
            ),
        attemptByRunId: (runId: string) =>
          runtime
            .query((q) => q.attemptByRunId(runId))
            .then((row) => {
              if (row === undefined) return undefined;
              const attempt = parseAttempt(row);
              return Object.freeze({
                workItemId: attempt.workItemId,
                attemptId: attempt.attemptId,
                attemptSeq: attempt.attemptSeq,
                sessionId: attempt.sessionId,
                runId: attempt.runId,
                status: attempt.status,
                prompt: attempt.prompt,
                model: attempt.model,
                connectorInstallationId: attempt.agentName,
                ...(attempt.connectorSettlement === undefined
                  ? {}
                  : { settlement: attempt.connectorSettlement }),
              });
            }),
      }),
      lifecycle: Object.freeze({
        createWork: async (input: Parameters<ConnectorLifecyclePort["createWork"]>[0]) => {
          await lifecycle(input);
        },
        readyWork: async (input: Parameters<ConnectorLifecyclePort["readyWork"]>[0]) => {
          await lifecycle(input);
        },
        allocateAttempt: async (
          input: Parameters<ConnectorLifecyclePort["allocateAttempt"]>[0],
        ) => {
          await lifecycle(input);
        },
        requestAttemptStart: async (
          input: Parameters<ConnectorLifecyclePort["requestAttemptStart"]>[0],
        ) => {
          const proof = await lifecycle(input);
          if (proof === undefined)
            throw new Error("connector start effect proof was not committed");
          return proof;
        },
        confirmAttemptStart: async (
          input: Parameters<ConnectorLifecyclePort["confirmAttemptStart"]>[0],
        ) => {
          await lifecycle(input);
        },
        settleAttempt: async (input: Parameters<ConnectorLifecyclePort["settleAttempt"]>[0]) => {
          await lifecycle(input);
        },
      }),
      artifacts: Object.freeze({
        async putAndReference(input: Parameters<ConnectorArtifactPort["putAndReference"]>[0]) {
          const operationId = input.transitionId;
          const operation = CONFIGURATION_OPERATION_CATALOG_V1.find(({ id }) => id === operationId);
          if (operation === undefined)
            throw new Error(`Unknown configuration operation ${operationId}`);
          const command = operation.command;
          const artifactOwner = owner(`session:${input.ownerSessionId}`);
          const head = await runtime.query((q) => q.head(artifactOwner));
          const occurredAtDbMs = options.clock.now();
          const artifactPayload = {
            version: "configuration-operation-payload-v1",
            operationId,
            command,
            owner: artifactOwner,
            subjectId: input.artifactId,
            recordVersion: 1,
            occurredAtDbMs,
            artifactId: input.artifactId,
            contentRef: input.blob.ref,
            title: input.title,
          };
          const configurationArtifact = {
            version: "configuration-artifact-v1",
            operationId,
            command,
            owner: artifactOwner,
            subjectId: input.artifactId,
            recordVersion: 1,
            occurredAtDbMs,
            payload: artifactPayload,
          };
          const configurationBlob = blob(configurationArtifact);
          const payload = { ...artifactPayload, configurationSnapshotRef: configurationBlob.ref };
          const commandRequest = {
            version: "kernel-transition-command-v1",
            transitionId: operationId,
            command,
            requestId: input.requestId,
            requestHash: digest(payload),
            identity: {
              version: "authenticated-worker-identity-v1",
              ...options.identity,
              sessionId: input.ownerSessionId,
              runId: input.artifactId,
              attemptId: input.artifactId,
            },
            expectedHead: head,
            payload,
          };
          pendingArtifacts.set(input.requestId, [
            { bytes: input.blob.bytes, ref: Execution.ContentBlobRefV1.parse(input.blob.ref) },
          ]);
          try {
            const result = await KernelLedgerRuntime.prototype.execute.call(kernel, commandRequest);
            if (result.status !== "committed")
              throw new Error(`artifact reference rejected: ${result.code}`);
          } finally {
            pendingArtifacts.delete(input.requestId);
          }
        },
      }),
    }),
    provisioning: Object.freeze({
      queries: Object.freeze({
        attempt: attemptRow,
        authorization,
        credentialRef: async (providerId: string) =>
          options.credentialRefs?.find((ref) => ref.providerId === providerId),
      }),
      transitions: Object.freeze({
        confirmAttemptRunning: async (
          input: Parameters<ProvisioningTransitionPort["confirmAttemptRunning"]>[0],
        ) => {
          const result = await simpleAttemptTransition(
            input.transitionId,
            input.attempt,
            input.requestId,
            runtime,
            execute,
            options.clock.now(),
          );
          if (result !== "committed") throw new Error("Attempt running confirmation conflicted");
        },
      }),
    }),
  });
}
