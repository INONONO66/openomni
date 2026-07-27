import { createHash } from "node:crypto";
import { type Execution, Ledger } from "@openomni/protocol";
import { nativeTransitionById } from "../native-transitions.js";
import type { KernelTransitionCommandV1 } from "../ports.js";
import { projectNativeEventPayload } from "./index.js";
import type { DispatchProjectionV1 } from "../reducers/dispatch.js";
import { reduceAttemptProjections } from "../reducers/attempt.js";
import { reduceWorkProjection } from "../reducers/work.js";

const ROUTE_DISPATCH_ID = /^(?:RT-(?:0[1-9]|1[0-7])|DP-(?:0[1-9]|1[0-9]|2[0-4])|XD-0[1-3])$/;
const CROSS_OWNER_SOURCE_IDS = new Set([
  "RT-03",
  "RT-04",
  "RT-13",
  "RT-14",
  "RT-15",
  "RT-16",
  "RT-17",
  "DP-12",
  "DP-18",
]);
const EFFECT_INTENT_IDS = new Set([
  "RT-04",
  "RT-05",
  "RT-11",
  "RT-12",
  "RT-13",
  "RT-14",
  "RT-15",
  "RT-16",
  "RT-17",
  "DP-05",
  "DP-06",
  "DP-08",
  "DP-12",
  "DP-13",
  "DP-14",
  "DP-16",
  "DP-17",
  "DP-18",
  "DP-19",
  "DP-20",
  "DP-21",
  "DP-22",
]);

export interface DefiniteDispatchFailureProofV1 {
  readonly version: "definite-dispatch-failure-proof-v1";
  readonly sourceOwnerKey: string;
  readonly dispatchId: string;
  readonly destinationOwnerKey: string;
  readonly destinationRequestId: string;
  readonly destinationHead: Ledger.HeadV1;
  readonly destinationState: "absent";
  readonly failureClass: "destination_append_definite_no_materialization";
}
export type RouteDispatchPhaseV1 = "source" | "destination" | "settlement";

export interface RouteDispatchProjectionV1 {
  readonly routeDecisions: ReadonlySet<string>;
  readonly dispatch: DispatchProjectionV1;
  readonly effectIntents: ReadonlySet<string>;
  /** Authoritative source-owner history through the exact source head. */
  readonly ownerEvents?: readonly Ledger.EnvelopeV1[];
  /** Authoritative destination-owner history through the exact destination head. */
  readonly destinationEvents?: readonly Ledger.EnvelopeV1[];
  readonly destinationHead?: Ledger.HeadV1;
  readonly destinationDispatch?: DispatchProjectionV1;
  /** Exact durable destination receipt proving that destination append committed. */
  readonly destinationReceipt?: Ledger.AppendReceiptV1;
  /** Exact durable, sanitized no-materialization proof for a definite destination failure. */
  readonly definiteFailure?: Readonly<{
    readonly ref: Execution.ContentBlobRefV1;
    readonly proof: DefiniteDispatchFailureProofV1;
  }>;
}

export interface PreparedRouteDispatchTransitionV1 {
  readonly transitionId: string;
  readonly phase: RouteDispatchPhaseV1;
  readonly owner: Ledger.OwnerV1;
  readonly expectedHead: Ledger.HeadV1;
  readonly eventTypes: readonly Ledger.NativeEventTypeV1[];
  readonly events: readonly Ledger.EventV1[];
  /** Durable evidence consumed while selecting this exact phase. */
  readonly evidenceRefs: readonly Execution.ContentBlobRefV1[];
  readonly append: Ledger.AppendBatchRequestV1;
}

export class IllegalRouteDispatchTransitionError extends Error {
  readonly code = "transition_forbidden" as const;

  constructor(
    readonly transitionId: string,
    readonly reason: string,
  ) {
    super(`illegal ${transitionId} transition: ${reason}`);
    this.name = "IllegalRouteDispatchTransitionError";
  }
}

function reject(command: KernelTransitionCommandV1, reason: string): never {
  throw new IllegalRouteDispatchTransitionError(command.transitionId, reason);
}

/** Exact immutable identity fields shared by XD-01 delivery and XD-02 settlement. */
export type CrossOwnerDestinationIdentityV1 = Readonly<{
  sourceOwnerKey: string;
  dispatchId: string;
}>;

export function crossOwnerDestinationRequestId(identity: CrossOwnerDestinationIdentityV1): string {
  const { sourceOwnerKey, dispatchId } = identity;
  return `cross-owner-destination:${sourceOwnerKey.length}:${sourceOwnerKey}:${dispatchId.length}:${dispatchId}`;
}

function crossOwnerDestinationIdentity(
  command: KernelTransitionCommandV1,
): CrossOwnerDestinationIdentityV1 {
  return {
    sourceOwnerKey: command.payload.owner.ownerKey,
    dispatchId: requiredSubjectId(command, "DP"),
  };
}

export function assertExactDestinationReceipt(
  command: KernelTransitionCommandV1,
  receipt: Ledger.AppendReceiptV1,
): void {
  if (!("facts" in command.payload)) reject(command, "dp_facts_required");
  const facts = (command.payload.facts as Execution.NativeTransitionPayloadV1["facts"]).DP;
  if (facts === undefined) reject(command, "dp_facts_required");
  if (facts.sourceOwner.ownerKey !== command.payload.owner.ownerKey) {
    reject(command, "source_owner_mismatch");
  }
  if (
    receipt.requestId !== crossOwnerDestinationRequestId(crossOwnerDestinationIdentity(command))
  ) {
    reject(command, "destination_receipt_request_mismatch");
  }
  if (receipt.principalId !== command.identity.principalId) {
    reject(command, "destination_receipt_principal_mismatch");
  }
  if (receipt.owner.ownerKey !== facts.destinationOwner.ownerKey) {
    reject(command, "destination_receipt_owner_mismatch");
  }
  const { receiptHash, ...receiptWithoutHash } = receipt;
  if (
    receiptHash !== createHash("sha256").update(canonicalJson(receiptWithoutHash)).digest("hex")
  ) {
    reject(command, "destination_receipt_hash_mismatch");
  }
  const expectedEventIds = [`${receipt.requestId}:XD-01:1`, `${receipt.requestId}:XD-01:2`];
  if (
    receipt.eventIds.length !== expectedEventIds.length ||
    receipt.eventIds.some((eventId, index) => eventId !== expectedEventIds[index])
  ) {
    reject(command, "destination_receipt_events_mismatch");
  }
}

function assertExactDefiniteFailureProof(
  command: KernelTransitionCommandV1,
  projection: RouteDispatchProjectionV1,
): void {
  if (!("facts" in command.payload)) reject(command, "dp_facts_required");
  const facts = (command.payload.facts as Execution.NativeTransitionPayloadV1["facts"]).DP;
  if (facts === undefined) reject(command, "dp_facts_required");
  if (facts.sourceOwner.ownerKey !== command.payload.owner.ownerKey) {
    reject(command, "source_owner_mismatch");
  }
  if (facts.settlement !== "definite_failed") {
    reject(command, "definite_failure_settlement_mismatch");
  }
  const evidence = projection.definiteFailure;
  if (evidence === undefined) reject(command, "definite_failure_proof_required");
  const { proof } = evidence;
  const destination = projection.destinationHead;
  if (destination === undefined) reject(command, "destination_head_required");
  const expectedRequestId = crossOwnerDestinationRequestId(crossOwnerDestinationIdentity(command));
  if (
    proof.sourceOwnerKey !== command.payload.owner.ownerKey ||
    proof.dispatchId !== facts.dispatchId ||
    proof.destinationOwnerKey !== facts.destinationOwner.ownerKey ||
    proof.destinationHead.owner.ownerKey !== facts.destinationOwner.ownerKey ||
    proof.destinationRequestId !== expectedRequestId
  ) {
    reject(command, "definite_failure_proof_identity_mismatch");
  }
  if (
    proof.destinationHead.owner.ownerKey !== destination.owner.ownerKey ||
    proof.destinationHead.ownerSeq !== destination.ownerSeq ||
    proof.destinationHead.eventHash !== destination.eventHash
  ) {
    reject(command, "definite_failure_proof_head_mismatch");
  }
  if (proof.destinationState !== "absent") {
    reject(command, "definite_failure_proof_ambiguous");
  }
  if (proof.failureClass !== "destination_append_definite_no_materialization") {
    reject(command, "definite_failure_class_ambiguous");
  }
  if (projection.destinationDispatch?.records.has(facts.dispatchId)) {
    reject(command, "destination_already_committed");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new TypeError("Receipt canonical JSON cannot encode undefined");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requiredSubjectId(command: KernelTransitionCommandV1, family: "RT" | "DP" | "EF"): string {
  if (!("facts" in command.payload)) reject(command, `${family.toLowerCase()}_facts_required`);
  const facts = command.payload.facts as Execution.NativeTransitionPayloadV1["facts"];
  const required = facts[family];
  if (required === undefined) reject(command, `${family.toLowerCase()}_facts_required`);
  return required.subjectId;
}

function assertBlobPersisted(
  command: KernelTransitionCommandV1,
  ref: Execution.ContentBlobRefV1,
  reason: string,
): void {
  if (ref.byteLength < 1 || ref.digest.length === 0) reject(command, reason);
}

function assertNativeFactBindings(
  command: KernelTransitionCommandV1,
  projection: RouteDispatchProjectionV1,
): void {
  // The runtime always supplies complete owner history. Direct preparer callers without that
  // authoritative read cannot claim these catalog assertions were evaluated.
  if (projection.ownerEvents === undefined) return;
  if (!("facts" in command.payload)) reject(command, "native_facts_required");
  const facts = command.payload.facts as Execution.NativeTransitionPayloadV1["facts"];
  const { RT, DP, WI, AT, CP, EF, SS, SF, MS } = facts;

  if (RT !== undefined) {
    if (RT.subjectId !== RT.routeId) reject(command, "route_identity_mismatch");
    if (
      !new Set(["RT-03", "RT-04", "RT-05", "RT-17"]).has(command.transitionId) &&
      command.payload.owner.ownerKey !== `session:${RT.sessionId}`
    ) {
      reject(command, "route_owner_mismatch");
    }
  }
  if (DP !== undefined) {
    if (DP.subjectId !== DP.dispatchId) reject(command, "dispatch_identity_mismatch");
    if (DP.sourceOwner.ownerKey !== command.payload.owner.ownerKey) {
      reject(command, "dispatch_source_owner_mismatch");
    }
    if (DP.settlement !== "pending" && !command.transitionId.startsWith("XD-")) {
      reject(command, "dispatch_initial_settlement_mismatch");
    }
  }
  if (WI !== undefined) {
    if (
      WI.subjectId !== WI.workItemId ||
      ((command.transitionId.startsWith("WI-") || command.transitionId === "DP-05") &&
        command.payload.owner.ownerKey !== `work:${WI.workItemId}`)
    ) {
      reject(command, "work_identity_mismatch");
    }
    assertBlobPersisted(command, WI.workSnapshotRef, "work_criteria_constraints_required");
  }
  if (AT !== undefined) {
    if (
      AT.subjectId !== AT.attempt.attemptId ||
      AT.runBinding.workItemId !== AT.attempt.workItemId ||
      AT.runBinding.attemptId !== AT.attempt.attemptId
    ) {
      reject(command, "attempt_binding_mismatch");
    }
    if (
      WI !== undefined &&
      (AT.attempt.workItemId !== WI.workItemId || AT.runBinding.sessionId !== WI.sessionId)
    ) {
      reject(command, "attempt_work_binding_mismatch");
    }
  }
  if (CP !== undefined) {
    if (CP.subjectId !== CP.workItemId) reject(command, "completion_work_binding_mismatch");
    if (
      AT === undefined ||
      CP.workItemId !== AT.attempt.workItemId ||
      CP.runBinding.workItemId !== AT.attempt.workItemId ||
      CP.runBinding.attemptId !== AT.attempt.attemptId ||
      CP.runBinding.sessionId !== AT.runBinding.sessionId ||
      CP.runBinding.runId !== AT.runBinding.runId
    ) {
      reject(command, "completion_attempt_binding_mismatch");
    }
  }
  if (EF !== undefined) {
    if (EF.subjectId !== EF.effect.effectId) reject(command, "effect_identity_mismatch");
    if (
      AT !== undefined &&
      (EF.attempt.workItemId !== AT.attempt.workItemId ||
        EF.attempt.attemptId !== AT.attempt.attemptId ||
        EF.attempt.attemptSeq !== AT.attempt.attemptSeq)
    )
      reject(command, "effect_attempt_binding_mismatch");
  }

  if (command.transitionId === "RT-12") {
    if ((projection.ownerEvents?.length ?? 0) !== 0 || command.expectedHead.ownerSeq !== 0) {
      reject(command, "new_resident_genesis_required");
    }
    if (
      RT === undefined ||
      SS === undefined ||
      SF === undefined ||
      MS === undefined ||
      EF === undefined ||
      SS.subjectId !== SS.sessionId ||
      SF.subjectId !== SF.surfaceId ||
      SS.sessionId !== RT?.sessionId ||
      SF.sessionId !== RT.sessionId ||
      MS.sessionId !== RT.sessionId ||
      MS.surfaceId !== RT.surfaceId ||
      MS.messageId !== RT.messageId
    )
      reject(command, "new_resident_atomic_binding_mismatch");
  }

  if (command.transitionId === "DP-05") {
    if ((projection.ownerEvents?.length ?? 0) !== 0 || command.expectedHead.ownerSeq !== 0) {
      reject(command, "spawn_work_genesis_required");
    }
    if (DP === undefined || WI === undefined || AT === undefined || EF === undefined) {
      reject(command, "spawn_atomic_facts_required");
    }
    if (
      DP.sourceSessionId !== command.identity.sessionId ||
      AT.attempt.attemptSeq !== 1 ||
      DP.sourceOwner.ownerKey !== command.payload.owner.ownerKey ||
      DP.destinationOwner.ownerKey !== command.payload.owner.ownerKey
    )
      reject(command, "resident_allocation_authority_mismatch");
  }

  if (command.transitionId === "DP-07" || command.transitionId === "DP-08") {
    if (AT === undefined || CP === undefined) reject(command, "completion_atomic_facts_required");
    const history = projection.ownerEvents ?? [];
    const work = reduceWorkProjection(AT.attempt.workItemId, history);
    const currentAttempt = reduceAttemptProjections(history).get(AT.attempt.attemptId);
    if (work === null || work.criteriaRef === null || work.evidenceRefs.length === 0) {
      reject(command, "current_criteria_evidence_required");
    }
    if (
      currentAttempt?.status !== "running" ||
      currentAttempt.attemptSeq !== AT.attempt.attemptSeq ||
      AT.runBinding.sessionId !== command.identity.sessionId ||
      AT.runBinding.runId !== command.identity.runId ||
      AT.attempt.attemptId !== command.identity.attemptId
    )
      reject(command, "exact_running_attempt_required");
    const allocated = history.find(
      ({ event }) =>
        event.eventType === "attempt.allocated.v1" &&
        event.payload.attemptId === AT.attempt.attemptId,
    )?.event.payload;
    if (
      allocated === undefined ||
      allocated.workItemId !== AT.attempt.workItemId ||
      allocated.attemptSeq !== AT.attempt.attemptSeq ||
      allocated.sessionId !== AT.runBinding.sessionId ||
      allocated.runId !== AT.runBinding.runId ||
      allocated.model?.provider !== AT.model.provider ||
      allocated.model?.id !== AT.model.id ||
      allocated.environmentSnapshotRef?.digest !== AT.environmentSnapshotRef.digest
    )
      reject(command, "immutable_attempt_binding_mismatch");
  }
  if (command.transitionId === "DP-09" || command.transitionId === "DP-10") {
    const workItemId = facts.WI?.workItemId;
    const work =
      workItemId === undefined ? null : reduceWorkProjection(workItemId, projection.ownerEvents);
    if (
      work === null ||
      work.status === "completed" ||
      work.status === "archived" ||
      work.status === "cancelled" ||
      work.status === "failed"
    )
      reject(command, "nonterminal_work_required");
  }
  if (command.transitionId === "DP-11") {
    const claimed = facts.AT?.attempt;
    const attempt =
      claimed === undefined
        ? undefined
        : reduceAttemptProjections(projection.ownerEvents).get(claimed.attemptId);
    if (
      attempt === undefined ||
      attempt.attemptSeq !== claimed?.attemptSeq ||
      attempt.status === "succeeded" ||
      attempt.status === "failed" ||
      attempt.status === "cancelled" ||
      attempt.status === "interrupted"
    )
      reject(command, "active_attempt_required");
  }
}

function dispatchRecord(command: KernelTransitionCommandV1, projection: RouteDispatchProjectionV1) {
  return projection.dispatch.records.get(requiredSubjectId(command, "DP"));
}

function assertDispatchTransition(
  command: KernelTransitionCommandV1,
  projection: RouteDispatchProjectionV1,
): RouteDispatchPhaseV1 {
  if (!ROUTE_DISPATCH_ID.test(command.transitionId)) reject(command, "operation_not_in_family");
  assertNativeFactBindings(command, projection);

  const isRoute = command.transitionId.startsWith("RT-");
  const subjectId = requiredSubjectId(command, isRoute ? "RT" : "DP");
  const record = isRoute ? undefined : dispatchRecord(command, projection);
  if (isRoute && projection.routeDecisions.has(subjectId)) {
    reject(command, "route_already_decided");
  }
  if (command.transitionId.startsWith("DP-") && record !== undefined) {
    reject(command, "dispatch_already_exists");
  }
  if (
    EFFECT_INTENT_IDS.has(command.transitionId) &&
    projection.effectIntents.has(requiredSubjectId(command, "EF"))
  ) {
    reject(command, "effect_already_pending");
  }

  if (CROSS_OWNER_SOURCE_IDS.has(command.transitionId)) {
    const destination = projection.destinationHead;
    if (destination === undefined) reject(command, "destination_head_required");
    if (destination.owner.ownerKey === command.payload.owner.ownerKey) {
      reject(command, "cross_owner_destination_required");
    }
    return "source";
  }

  if (command.transitionId === "XD-01") {
    if (record?.status !== "pending") reject(command, "source_pending_required");
    const destination = projection.destinationHead;
    if (destination === undefined) reject(command, "destination_head_required");
    if (destination.owner.ownerKey === command.payload.owner.ownerKey) {
      reject(command, "cross_owner_destination_required");
    }
    if (!("facts" in command.payload)) reject(command, "dp_facts_required");
    const facts = (command.payload.facts as Execution.NativeTransitionPayloadV1["facts"]).DP;
    if (facts === undefined) reject(command, "dp_facts_required");
    if (facts.sourceOwner.ownerKey !== command.payload.owner.ownerKey) {
      reject(command, "source_owner_mismatch");
    }
    if (destination.owner.ownerKey !== facts.destinationOwner.ownerKey) {
      reject(command, "destination_owner_mismatch");
    }
    if (projection.destinationDispatch?.records.has(subjectId)) {
      reject(command, "destination_already_received");
    }
    return "destination";
  }

  if (command.transitionId === "XD-02") {
    if (record?.status !== "pending") reject(command, "source_pending_required");
    const receipt = projection.destinationReceipt;
    if (receipt === undefined) reject(command, "destination_receipt_required");
    assertExactDestinationReceipt(command, receipt);
    return "settlement";
  }

  if (command.transitionId === "XD-03") {
    if (record?.status !== "pending") reject(command, "source_pending_required");
    if (projection.destinationReceipt !== undefined)
      reject(command, "destination_already_committed");
    assertExactDefiniteFailureProof(command, projection);
    return "settlement";
  }

  return "source";
}

function eventTypesFor(
  command: KernelTransitionCommandV1,
  phase: RouteDispatchPhaseV1,
): readonly Ledger.NativeEventTypeV1[] {
  const emission = nativeTransitionById(command.transitionId).emission;
  if (emission.kind === "batch") {
    return emission.eventTypes.map((eventType) => Ledger.NativeEventTypeV1.parse(eventType));
  }
  if (emission.kind === "conditional-batch") {
    const selected =
      "facts" in command.payload &&
      (command.payload.facts as Execution.NativeTransitionPayloadV1["facts"]).AT !== undefined
        ? emission.sourceRunEventTypes
        : emission.sourceNonRunEventTypes;
    return selected.map((eventType) => Ledger.NativeEventTypeV1.parse(eventType));
  }
  if (emission.kind !== "cross-owner") reject(command, "operation_has_no_commit");
  if (phase === "source") {
    return emission.sourceEventTypes.map((eventType) => Ledger.NativeEventTypeV1.parse(eventType));
  }
  if (phase === "destination") {
    return emission.destinationEventTypes.map((eventType) =>
      Ledger.NativeEventTypeV1.parse(eventType),
    );
  }
  return emission.settlementEventTypes.map((eventType) =>
    Ledger.NativeEventTypeV1.parse(eventType),
  );
}

function ownerAndHead(
  command: KernelTransitionCommandV1,
  projection: RouteDispatchProjectionV1,
  phase: RouteDispatchPhaseV1,
): { readonly owner: Ledger.OwnerV1; readonly head: Ledger.HeadV1 } {
  if (phase !== "destination") return { owner: command.payload.owner, head: command.expectedHead };
  const head = projection.destinationHead;
  if (head === undefined) reject(command, "destination_head_required");
  return { owner: head.owner, head };
}

/**
 * Prepares exactly one durable phase. Cross-owner delivery is deliberately never collapsed into a
 * multi-owner write: source pending, destination receipt, and source settlement are separate CAS
 * appends. Drivers may act only after the event batch containing effect.intent.v1 commits.
 */
export function prepareRouteDispatchTransition(
  command: KernelTransitionCommandV1,
  currentProjection: RouteDispatchProjectionV1,
): PreparedRouteDispatchTransitionV1 {
  const phase = assertDispatchTransition(command, currentProjection);
  const eventTypes = Object.freeze([...eventTypesFor(command, phase)]);
  const { owner, head } = ownerAndHead(command, currentProjection, phase);
  const evidenceRefs = Object.freeze(
    command.transitionId === "XD-03" && currentProjection.definiteFailure !== undefined
      ? [currentProjection.definiteFailure.ref]
      : [],
  );
  const destinationRequestId =
    phase === "destination"
      ? crossOwnerDestinationRequestId(crossOwnerDestinationIdentity(command))
      : undefined;
  const phaseRequestId =
    phase === "source"
      ? command.requestId
      : (destinationRequestId ?? `${command.requestId}:${phase}`);
  const events = Object.freeze(
    eventTypes.map((eventType, index) =>
      Ledger.EventV1.parse({
        version: "ledger-event-v1",
        eventId: `${phaseRequestId}:${command.transitionId}:${index + 1}`,
        eventType,
        eventVersion: 1,
        owner,
        payload: projectNativeEventPayload(command, eventType),
        provenance: {
          version: "native-event-provenance-v1",
          principalId: command.identity.principalId,
          requestId: phaseRequestId,
        },
      }),
    ),
  );
  const append = Ledger.AppendBatchRequestV1.parse({
    version: "ledger-append-batch-request-v1",
    requestId: phaseRequestId,
    requestHash: command.requestHash,
    principalId: command.identity.principalId,
    expectedHead: head,
    batch: {
      version: "ledger-batch-v1",
      batchId: `${phaseRequestId}:${command.transitionId}`,
      owner,
      events,
    },
  });
  return Object.freeze({
    transitionId: command.transitionId,
    phase,
    owner,
    expectedHead: head,
    eventTypes,
    events,
    evidenceRefs,
    append,
  });
}
