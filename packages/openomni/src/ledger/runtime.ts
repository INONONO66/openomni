import { Execution, type Ledger } from "@openomni/protocol";
import { createHash } from "node:crypto";
import { Bus, BusEvent } from "@openomni/session";
import { z } from "zod";
import { assertTransitionGuards, KernelGuardError } from "./reducers/index.js";
import { emptyDispatchProjection, reduceDispatch } from "./reducers/dispatch.js";
import {
  parseClosedKernelCommand,
  prepareGrantScheduleEffectTransition,
  prepareMessagingTransition,
  prepareWaitTransition,
  prepareWorkAttemptCompletionTransition,
  UnknownKernelTransitionError,
} from "./transitions/index.js";
import {
  isConfigurationOperationId,
  prepareConfigurationArtifactTransition,
} from "./transitions/configuration-artifact.js";
import {
  assertExactDestinationReceipt,
  crossOwnerDestinationRequestId,
  IllegalRouteDispatchTransitionError,
  prepareRouteDispatchTransition,
  type RouteDispatchProjectionV1,
} from "./transitions/route-dispatch.js";
import {
  parseDefiniteDispatchFailureProofBlob,
  type MessagingAccessSnapshotBlobV1,
} from "./production/messaging-access.js";
import type {
  AuthoritativeWriterPortV1,
  KernelProjectionPortV1,
  KernelOwnerEventReaderPortV1,
  KernelLedgerDiagnosticCountersV1,
  KernelLedgerFailureClassV1,
  KernelLedgerIncidentSinkV1,
  KernelQueryPortV1,
  KernelQueryResultV1,
  KernelQueryV1,
  KernelTransitionPortV1,
  KernelTransitionCommandV1,
  KernelTransitionResultV1,
} from "./ports.js";

function crossOwnerDestinationIdentity(command: KernelTransitionCommandV1) {
  if (!("facts" in command.payload) || command.payload.facts.DP === undefined) {
    throw new TypeError("Cross-owner destination requires DP facts");
  }
  return {
    sourceOwnerKey: command.payload.owner.ownerKey,
    dispatchId: command.payload.facts.DP.subjectId,
  };
}

const committedObservationSchema = z.object({
  transitionId: z.string().min(1),
  command: z.string().min(1),
  requestId: z.string().min(1),
  ownerKey: z.string().min(1),
  eventIds: z.array(z.string().min(1)),
});

export const KernelLedgerEvents = Object.freeze({
  Committed: BusEvent.define("kernel.ledger.transition.committed", committedObservationSchema),
});

export type KernelCommittedObservationV1 = z.infer<typeof committedObservationSchema>;

export interface DefiniteDispatchFailureProofReadV1 {
  readonly sourceOwnerKey: string;
  readonly dispatchId: string;
  readonly proofRef: Execution.ContentBlobRefV1;
  readonly destinationOwnerKey: string;
  readonly destinationRequestId: string;
}
export interface KernelLedgerRuntimeOptionsV1 {
  readonly writer: AuthoritativeWriterPortV1;
  readonly projections: KernelProjectionPortV1;
  readonly ownerEvents: KernelOwnerEventReaderPortV1;
  readonly incidentSink: KernelLedgerIncidentSinkV1;
  /** Durable proof storage; absence keeps XD-03 pending and fails closed. */
  readonly readDefiniteDispatchFailureProof?: (
    request: DefiniteDispatchFailureProofReadV1,
  ) => Promise<MessagingAccessSnapshotBlobV1 | undefined>;
  readonly publishObservation?: (observation: KernelCommittedObservationV1) => void;
}
interface PreparedWriterAppendV1 {
  readonly append: Ledger.AppendBatchRequestV1;
  readonly artifactBlobs: readonly {
    readonly bytes: Uint8Array;
    readonly expectedHash: `sha256:${string}`;
  }[];
}

export interface KernelLedgerRuntimeV1 extends KernelTransitionPortV1, KernelQueryPortV1 {
  diagnosticCounters(): KernelLedgerDiagnosticCountersV1;
}

class DestinationAppendDefiniteNoMaterializationError extends Error {
  readonly code = "transition_forbidden" as const;

  constructor(readonly cause: IllegalRouteDispatchTransitionError) {
    super(cause.message);
    this.name = "DestinationAppendDefiniteNoMaterializationError";
  }
}
export class KernelLedgerRuntime implements KernelLedgerRuntimeV1 {
  private readonly publishObservation: (observation: KernelCommittedObservationV1) => void;
  private readonly counters = {
    transitionParse: 0,
    transitionGuard: 0,
    append: 0,
    projection: 0,
    observationPublication: 0,
    incidentSink: 0,
  };

  constructor(private readonly options: KernelLedgerRuntimeOptionsV1) {
    this.publishObservation =
      options.publishObservation ??
      ((observation) => Bus.publish(KernelLedgerEvents.Committed, observation));
  }

  async execute(input: unknown): Promise<KernelTransitionResultV1> {
    let command: KernelTransitionCommandV1;
    try {
      command = parseClosedKernelCommand(input);
    } catch (error) {
      const code = codeFor(error);
      this.reportFailure("transition_parse", "rejected", code);
      return rejected(code);
    }

    let failureClass: KernelLedgerFailureClassV1 = "transition_guard";
    let destinationReceiptAbsenceEstablished = false;
    try {
      const authoritativeOwner = await this.authoritativeOwner(command);
      const priorReceipt = await this.options.writer.findReceipt(replayReceiptRequestId(command));
      destinationReceiptAbsenceEstablished =
        command.transitionId === "XD-01" && priorReceipt === null;
      if (priorReceipt !== null) {
        if (command.transitionId === "XD-01") {
          assertExactDestinationReceipt(command, priorReceipt);
          return committed(priorReceipt);
        }
        return await this.replayCommitted(command, priorReceipt);
      }

      const currentHead = await this.options.writer.readHead(authoritativeOwner);
      const ownerEvents =
        currentHead.ownerSeq === 0
          ? []
          : await this.options.ownerEvents.readOwnerEvents(
              authoritativeOwner,
              currentHead.ownerSeq,
            );
      assertExactHead(command, currentHead);
      assertExactOwnerHistory(authoritativeOwner, currentHead, ownerEvents);

      const prepared = await this.prepareClosedFamily(command, ownerEvents);
      if (prepared === null) {
        this.reportFailure("transition_guard", "rejected", "transition_forbidden");
        return rejected("transition_forbidden");
      }
      const { append } = prepared;
      if (append.requestId !== command.requestId) {
        const priorPhaseReceipt = await this.options.writer.findReceipt(append.requestId);
        if (priorPhaseReceipt !== null) {
          if (
            priorPhaseReceipt.requestHash !== command.requestHash ||
            priorPhaseReceipt.principalId !== command.identity.principalId
          ) {
            this.reportFailure("transition_guard", "rejected", "idempotency_mismatch");
            return rejected("idempotency_mismatch");
          }
          return committed(priorPhaseReceipt);
        }
      }

      // This is the sole write call. Canonical transition bytes, ledger facts, and projections
      // enter the structural writer's single transaction together.
      failureClass = "append";
      const receipt = await this.options.writer.appendBatch(append, {
        artifactBlobs: prepared.artifactBlobs,
      });
      this.observeCommitted({
        transitionId: command.transitionId,
        command: command.command,
        requestId: command.requestId,
        ownerKey: receipt.owner.ownerKey,
        eventIds: [...receipt.eventIds],
      });
      return committed(receipt);
    } catch (error) {
      const code = codeFor(error);
      this.reportFailure(
        failureClass === "append" ? appendFailureClass(error) : failureClass,
        "rejected",
        code,
      );
      return rejected(
        code,
        destinationReceiptAbsenceEstablished &&
          failureClass === "transition_guard" &&
          error instanceof DestinationAppendDefiniteNoMaterializationError
          ? "destination_append_definite_no_materialization"
          : undefined,
      );
    }
  }

  private async replayCommitted(
    command: KernelTransitionCommandV1,
    receipt: Ledger.AppendReceiptV1,
  ): Promise<KernelTransitionResultV1> {
    const ownerEvents = await this.options.ownerEvents.readOwnerEvents(
      receipt.owner,
      receipt.head.ownerSeq,
    );
    assertExactOwnerHistory(receipt.owner, receipt.head, ownerEvents);
    const priorOwnerEvents = ownerEvents.slice(0, receipt.previousHead.ownerSeq);
    assertExactOwnerHistory(receipt.owner, receipt.previousHead, priorOwnerEvents);
    const replayCommand = { ...command, expectedHead: receipt.previousHead };
    const prepared = await this.prepareClosedFamily(replayCommand, priorOwnerEvents);
    if (prepared === null) throw new KernelGuardError("transition_forbidden");
    assertExactAppendReceipt(
      prepared.append,
      receipt,
      ownerEvents.slice(receipt.previousHead.ownerSeq),
    );
    return committed(receipt);
  }

  diagnosticCounters(): KernelLedgerDiagnosticCountersV1 {
    return Object.freeze({ ...this.counters });
  }

  private observeCommitted(observation: KernelCommittedObservationV1): void {
    try {
      this.publishObservation(observation);
    } catch {
      // Observation is post-commit and lossy, but its failure is never silent.
      this.reportFailure("observation_publication", "committed", "observation_publication_failed");
    }
  }

  private reportFailure(
    failureClass: KernelLedgerFailureClassV1,
    outcome: "rejected" | "committed" | "thrown",
    code: Parameters<KernelLedgerIncidentSinkV1["report"]>[0]["code"],
  ): void {
    const counter = counterFor(failureClass);
    const occurrence = incrementCounter(this.counters[counter]);
    this.counters[counter] = occurrence;
    try {
      this.options.incidentSink.report(
        Object.freeze({
          version: "kernel-ledger-incident-v1",
          failureClass,
          outcome,
          code,
          occurrence,
        }),
      );
    } catch {
      // Never recurse into the failed sink or copy its error across the diagnostic boundary.
      this.counters.incidentSink = incrementCounter(this.counters.incidentSink);
    }
  }

  private async prepareClosedFamily(
    command: KernelTransitionCommandV1,
    ownerEvents: readonly Ledger.EnvelopeV1[],
  ): Promise<PreparedWriterAppendV1 | null> {
    const family = command.transitionId.slice(0, 2);
    switch (family) {
      case "SS":
      case "SF":
      case "MS": {
        assertTransitionGuards(command, command.expectedHead, ownerEvents);
        const append = prepareMessagingTransition(command).append;
        return append === null ? null : { append, artifactBlobs: [] };
      }
      case "RT":
      case "DP":
      case "XD": {
        const append = (await this.prepareRouteDispatch(command, ownerEvents)).append;
        return append === null ? null : { append, artifactBlobs: [] };
      }
      case "WI":
      case "AT":
      case "CP": {
        const append = prepareWorkAttemptCompletionTransition(command, ownerEvents).append;
        return append === null ? null : { append, artifactBlobs: [] };
      }
      case "WT": {
        const append = prepareWaitTransition(command, ownerEvents).append;
        return append === null ? null : { append, artifactBlobs: [] };
      }
      case "GR":
      case "SC":
      case "EF": {
        const append = prepareGrantScheduleEffectTransition(command, ownerEvents).append;
        return append === null ? null : { append, artifactBlobs: [] };
      }
      case "AF":
      case "AI":
      case "AE":
      case "BL":
      case "CG":
      case "CI": {
        if (!isConfigurationOperationId(command.transitionId)) {
          throw new UnknownKernelTransitionError(command.transitionId);
        }
        const prior = ownerEvents.filter(({ event }) => {
          const operationId = configurationOperationForEvent(event.eventType);
          return (
            event.payload.subjectId === command.payload.subjectId &&
            operationId?.slice(0, 2) === family &&
            event.payload.configurationSnapshotRef !== undefined
          );
        });
        const priorOperationIds = prior.map(({ event }) => {
          const operationId = configurationOperationForEvent(event.eventType);
          if (operationId === undefined)
            throw new KernelGuardError("configuration_history_invalid");
          return operationId;
        });
        const previous = prior.at(-1)?.event.payload.configurationSnapshotRef;
        const prepared = prepareConfigurationArtifactTransition(command, {
          priorRecordCount: prior.length,
          priorOperationIds,
          ...(previous === undefined ? {} : { priorSnapshotRef: previous }),
        });
        return {
          append: prepared.append,
          artifactBlobs: prepared.artifacts.map(({ hash, bytes }) => ({
            expectedHash: hash,
            bytes,
          })),
        };
      }
      default:
        throw new UnknownKernelTransitionError(command.transitionId);
    }
  }

  private async prepareRouteDispatch(
    command: KernelTransitionCommandV1,
    ownerEvents: readonly Ledger.EnvelopeV1[],
  ) {
    const dispatch = ownerEvents.reduce(reduceDispatch, emptyDispatchProjection());
    const routeDecisions = new Set(
      ownerEvents
        .filter(({ event }) => event.eventType === "kernel.route.decided.v1")
        .map(({ event }) => event.payload.subjectId),
    );
    const effectIntents = new Set(
      ownerEvents
        .filter(({ event }) => event.eventType === "effect.intent.v1")
        .map(({ event }) => event.payload.subjectId),
    );
    const projection: RouteDispatchProjectionV1 = {
      routeDecisions,
      dispatch,
      effectIntents,
      ownerEvents,
    };
    if (!("facts" in command.payload)) return prepareRouteDispatchTransition(command, projection);
    const destinationOwner = command.payload.facts.DP?.destinationOwner;
    if (
      destinationOwner !== undefined &&
      destinationOwner.ownerKey !== command.payload.owner.ownerKey
    ) {
      const destinationRequestId = crossOwnerDestinationRequestId(
        crossOwnerDestinationIdentity(command),
      );
      const dispatchFacts = command.payload.facts.DP;
      if (dispatchFacts === undefined) throw new KernelGuardError("dp_facts_required");
      const dispatchId = dispatchFacts.dispatchId;
      const definiteFailureBlob =
        command.transitionId === "XD-03" && dispatchFacts.definiteFailureProofRef !== null
          ? await this.options.readDefiniteDispatchFailureProof?.({
              sourceOwnerKey: command.payload.owner.ownerKey,
              dispatchId,
              destinationOwnerKey: destinationOwner.ownerKey,
              destinationRequestId,
              proofRef: dispatchFacts.definiteFailureProofRef,
            })
          : undefined;
      const definiteFailure =
        definiteFailureBlob === undefined
          ? undefined
          : {
              ref: definiteFailureBlob.ref,
              proof: parseDefiniteDispatchFailureProofBlob(definiteFailureBlob),
            };
      const currentDestinationHead = await this.options.writer.readHead(destinationOwner);
      const destinationEvents =
        currentDestinationHead.ownerSeq === 0
          ? []
          : await this.options.ownerEvents.readOwnerEvents(
              destinationOwner,
              currentDestinationHead.ownerSeq,
            );
      assertExactOwnerHistory(destinationOwner, currentDestinationHead, destinationEvents);
      if (definiteFailure !== undefined) {
        const proofHead = definiteFailure.proof.destinationHead;
        if (proofHead.ownerSeq > currentDestinationHead.ownerSeq) {
          throw new KernelGuardError("definite_failure_proof_head_mismatch");
        }
        assertExactOwnerHistory(
          destinationOwner,
          proofHead,
          destinationEvents.slice(0, proofHead.ownerSeq),
        );
      }
      const destinationDispatch = destinationEvents.reduce(
        reduceDispatch,
        emptyDispatchProjection(),
      );
      const destinationReceipt =
        command.transitionId === "XD-02" || command.transitionId === "XD-03"
          ? ((await this.options.writer.findReceipt(destinationRequestId)) ?? undefined)
          : undefined;
      try {
        return prepareRouteDispatchTransition(command, {
          ...projection,
          destinationHead:
            command.transitionId === "XD-03" && definiteFailure !== undefined
              ? definiteFailure.proof.destinationHead
              : currentDestinationHead,
          destinationEvents,
          destinationDispatch,
          destinationReceipt,
          definiteFailure,
        });
      } catch (error) {
        if (
          command.transitionId === "XD-01" &&
          !destinationDispatch.records.has(dispatchId) &&
          error instanceof IllegalRouteDispatchTransitionError
        ) {
          throw new DestinationAppendDefiniteNoMaterializationError(error);
        }
        throw error;
      }
    }
    return prepareRouteDispatchTransition(command, projection);
  }

  async query(input: KernelQueryV1): Promise<KernelQueryResultV1> {
    try {
      const request = Execution.KernelQueryV1.parse(input);
      const result = await this.options.projections.query(request);
      return Execution.KernelQueryResultV1.parse(result);
    } catch {
      this.reportFailure("projection", "thrown", "projection_failed");
      throw new Error("Kernel projection failed");
    }
  }

  private async authoritativeOwner(command: KernelTransitionCommandV1): Promise<Ledger.OwnerV1> {
    if (command.transitionId !== "AT-12" || !("facts" in command.payload)) {
      return command.payload.owner;
    }
    const claimedAttempt = command.payload.facts.EF?.attempt;
    if (claimedAttempt === undefined) throw new KernelGuardError("attempt_binding_mismatch");
    const result = await this.options.projections.query({
      version: "kernel-query-v1",
      kind: "authenticated_attempt",
      identity: command.identity,
      attempt: claimedAttempt,
    });
    if (result.kind !== "authenticated_attempt") {
      throw new KernelGuardError("attempt_binding_mismatch");
    }
    const authoritativeAttempt = result.attempt;
    if (
      authoritativeAttempt.attemptId !== claimedAttempt.attemptId ||
      authoritativeAttempt.attemptSeq !== claimedAttempt.attemptSeq ||
      authoritativeAttempt.workItemId !== claimedAttempt.workItemId ||
      command.identity.attemptId !== authoritativeAttempt.attemptId
    ) {
      throw new KernelGuardError("attempt_binding_mismatch");
    }
    const owner: Ledger.OwnerV1 = {
      version: "ledger-owner-v1",
      ownerKey: `work:${authoritativeAttempt.workItemId}`,
    };
    if (
      command.payload.owner.ownerKey !== owner.ownerKey ||
      command.expectedHead.owner.ownerKey !== owner.ownerKey
    ) {
      throw new KernelGuardError("work_owner_binding_mismatch");
    }
    return owner;
  }
}
function incrementCounter(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function appendFailureClass(error: unknown): "append" | "projection" {
  if (typeof error !== "object" || error === null) return "append";
  if ("code" in error && error.code === "projection_failed") return "projection";
  if (
    "detail" in error &&
    typeof error.detail === "object" &&
    error.detail !== null &&
    (error.detail as { code?: unknown }).code === "projection_failed"
  )
    return "projection";
  return "append";
}

function counterFor(
  failureClass: KernelLedgerFailureClassV1,
): Exclude<keyof KernelLedgerDiagnosticCountersV1, "incidentSink"> {
  switch (failureClass) {
    case "transition_parse":
      return "transitionParse";
    case "transition_guard":
      return "transitionGuard";
    case "append":
      return "append";
    case "projection":
      return "projection";
    case "observation_publication":
      return "observationPublication";
  }
}

export function createKernelLedgerRuntime(
  options: KernelLedgerRuntimeOptionsV1,
): KernelLedgerRuntimeV1 {
  return Object.freeze(new KernelLedgerRuntime(options));
}

function replayReceiptRequestId(command: KernelTransitionCommandV1): string {
  if (command.transitionId === "XD-01") {
    return crossOwnerDestinationRequestId(crossOwnerDestinationIdentity(command));
  }
  return command.transitionId === "XD-02" || command.transitionId === "XD-03"
    ? `${command.requestId}:settlement`
    : command.requestId;
}

function assertExactAppendReceipt(
  append: Ledger.AppendBatchRequestV1,
  receipt: Ledger.AppendReceiptV1,
  envelopes: readonly Ledger.EnvelopeV1[],
): void {
  const expectedEventIds = append.batch.events.map(({ eventId }) => eventId);
  if (
    receipt.requestId !== append.requestId ||
    receipt.requestHash !== append.requestHash ||
    receipt.principalId !== append.principalId ||
    receipt.owner.ownerKey !== append.batch.owner.ownerKey ||
    !headsEqual(receipt.previousHead, append.expectedHead) ||
    receipt.eventIds.length !== expectedEventIds.length ||
    receipt.eventIds.some((eventId, index) => eventId !== expectedEventIds[index]) ||
    receipt.lastLedgerSeq - receipt.firstLedgerSeq + 1 !== expectedEventIds.length
  ) {
    throw new KernelGuardError("idempotency_mismatch");
  }
  if (envelopes.length !== append.batch.events.length) {
    throw new KernelGuardError("idempotency_mismatch");
  }
  for (const [index, envelope] of envelopes.entries()) {
    const event = append.batch.events[index];
    if (event === undefined) {
      throw new KernelGuardError("idempotency_mismatch");
    }
    if (
      envelope.ledgerSeq !== receipt.firstLedgerSeq + index ||
      envelope.ownerSeq !== append.expectedHead.ownerSeq + index + 1 ||
      envelope.requestId !== append.requestId ||
      envelope.requestHash !== append.requestHash ||
      envelope.principalId !== append.principalId ||
      envelope.batch.batchId !== append.batch.batchId ||
      envelope.batch.index !== index ||
      envelope.batch.size !== append.batch.events.length ||
      canonicalJson(envelope.event) !== canonicalJson(event)
    ) {
      throw new KernelGuardError("idempotency_mismatch");
    }
  }
  let ownerSeq = append.expectedHead.ownerSeq;
  let eventHash = append.expectedHead.eventHash;
  for (const [batchIndex, event] of append.batch.events.entries()) {
    ownerSeq += 1;
    eventHash = createHash("sha256")
      .update(
        canonicalJson({
          version: "ledger-envelope-v1",
          envelopeVersion: 1,
          event,
          batchId: append.batch.batchId,
          batchIndex,
          batchSize: append.batch.events.length,
          ownerSeq,
          previousEventHash: eventHash,
          requestId: append.requestId,
          requestHash: append.requestHash,
          principalId: append.principalId,
        }),
      )
      .digest("hex");
  }
  if (
    receipt.head.owner.ownerKey !== append.batch.owner.ownerKey ||
    receipt.head.ownerSeq !== ownerSeq ||
    receipt.head.eventHash !== eventHash
  ) {
    throw new KernelGuardError("idempotency_mismatch");
  }
  const { receiptHash, ...receiptWithoutHash } = receipt;
  if (
    receiptHash !== createHash("sha256").update(canonicalJson(receiptWithoutHash)).digest("hex")
  ) {
    throw new KernelGuardError("idempotency_mismatch");
  }
}

function headsEqual(left: Ledger.HeadV1, right: Ledger.HeadV1): boolean {
  return (
    left.owner.ownerKey === right.owner.ownerKey &&
    left.ownerSeq === right.ownerSeq &&
    left.eventHash === right.eventHash
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("Ledger canonical JSON cannot encode undefined");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function committed(receipt: Ledger.AppendReceiptV1): KernelTransitionResultV1 {
  return { version: "kernel-transition-result-v1", status: "committed", receipt };
}

function rejected(
  code: Extract<KernelTransitionResultV1, { status: "rejected" }>["code"],
  definiteFailureClass?: "destination_append_definite_no_materialization",
): KernelTransitionResultV1 {
  return {
    version: "kernel-transition-result-v1",
    status: "rejected",
    code,
    ...(definiteFailureClass === undefined ? {} : { definiteFailureClass }),
  };
}

function assertExactHead(command: KernelTransitionCommandV1, currentHead: Ledger.HeadV1): void {
  if (
    currentHead.owner.ownerKey !== command.expectedHead.owner.ownerKey ||
    currentHead.ownerSeq !== command.expectedHead.ownerSeq ||
    currentHead.eventHash !== command.expectedHead.eventHash
  ) {
    throw new KernelGuardError("head_conflict");
  }
}

function assertExactOwnerHistory(
  owner: Ledger.OwnerV1,
  head: Ledger.HeadV1,
  events: readonly Ledger.EnvelopeV1[],
): void {
  if (head.owner.ownerKey !== owner.ownerKey) {
    throw new KernelGuardError("projection_owner_mismatch");
  }
  if (events.length !== head.ownerSeq) throw new KernelGuardError("projection_sequence_mismatch");
  let previousHash: Ledger.EnvelopeV1["previousEventHash"] = "GENESIS_V1";
  for (let index = 0; index < events.length; index += 1) {
    const envelope = events[index];
    if (envelope === undefined) {
      throw new KernelGuardError("projection_history_mismatch");
    }
    if (
      envelope.event.owner.ownerKey !== owner.ownerKey ||
      envelope.ownerSeq !== index + 1 ||
      envelope.previousEventHash !== previousHash
    ) {
      throw new KernelGuardError("projection_history_mismatch");
    }
    previousHash = envelope.eventHash;
  }
  if (previousHash !== head.eventHash) throw new KernelGuardError("projection_head_mismatch");
}

function codeFor(
  error: unknown,
): Extract<KernelTransitionResultV1, { status: "rejected" }>["code"] {
  if (error instanceof KernelGuardError) {
    return error.reason === "head_conflict" ? "head_conflict" : "transition_forbidden";
  }
  if (error instanceof UnknownKernelTransitionError) return "transition_forbidden";
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (
      code === "identity_mismatch" ||
      code === "head_conflict" ||
      code === "idempotency_mismatch"
    ) {
      return code;
    }
    if ("detail" in error && typeof error.detail === "object" && error.detail !== null) {
      const detailCode = (error.detail as { code?: unknown }).code;
      if (detailCode === "head_conflict" || detailCode === "idempotency_mismatch") {
        return detailCode;
      }
    }
  }
  return "transition_forbidden";
}

const CONFIGURATION_OPERATION_BY_EVENT = Object.freeze({
  "artifact.referenced.v1": "AF-01",
  "actor.identity_registered.v1": "AI-01",
  "actor.identity_revised.v1": "AI-02",
  "actor.identity_retired.v1": "AI-03",
  "actor.endpoint_bound.v1": "AE-01",
  "actor.endpoint_rebound.v1": "AE-02",
  "actor.endpoint_unbound.v1": "AE-03",
  "authority.blacklist_created.v1": "BL-01",
  "authority.blacklist_revised.v1": "BL-02",
  "authority.blacklist_revoked.v1": "BL-03",
  "authority.blacklist_expired.v1": "BL-04",
  "authority.channel_grant_created.v1": "CG-01",
  "authority.channel_grant_revised.v1": "CG-02",
  "authority.channel_grant_revoked.v1": "CG-03",
  "connector.installation_registered.v1": "CI-01",
  "connector.definition_revised.v1": "CI-02",
  "connector.consent_requested.v1": "CI-03",
  "connector.consent_granted.v1": "CI-04",
  "connector.verification_requested.v1": "CI-05",
  "connector.verified.v1": "CI-06",
  "connector.verification_failed.v1": "CI-07",
  "connector.disabled.v1": "CI-08",
  "connector.uninstalled.v1": "CI-09",
} as const);

function configurationOperationForEvent(
  eventType: string,
):
  | (typeof CONFIGURATION_OPERATION_BY_EVENT)[keyof typeof CONFIGURATION_OPERATION_BY_EVENT]
  | undefined {
  return CONFIGURATION_OPERATION_BY_EVENT[
    eventType as keyof typeof CONFIGURATION_OPERATION_BY_EVENT
  ];
}
