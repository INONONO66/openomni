export const NATIVE_TRANSITION_CATALOG_VERSION = "native-transition-catalog-r9-v1" as const;

export const NATIVE_TRANSITION_FAMILY_CARDINALITIES = Object.freeze({
  SS: 5,
  SF: 3,
  MS: 7,
  RT: 17,
  DP: 24,
  WI: 17,
  CP: 4,
  AT: 15,
  WT: 15,
  GR: 4,
  SC: 2,
  XD: 3,
  EF: 4,
} as const);
export const CONFIGURATION_OPERATION_FAMILY_CARDINALITIES = Object.freeze({
  AF: 1,
  AI: 3,
  AE: 3,
  BL: 4,
  CG: 3,
  CI: 9,
} as const);

export type ConfigurationOperationFamily =
  keyof typeof CONFIGURATION_OPERATION_FAMILY_CARDINALITIES;
export type ConfigurationOperationId = `${ConfigurationOperationFamily}-${string}`;

export type NativeTransitionFamily = keyof typeof NATIVE_TRANSITION_FAMILY_CARDINALITIES;
export type NativeTransitionId = `${NativeTransitionFamily}-${string}`;
export type OwnerDerivationClass =
  | "session-owner"
  | "surface-session-owner"
  | "work-owner"
  | "attempt-derived-work-owner"
  | "wait-owner"
  | "grant-owner"
  | "schedule-owner"
  | "effect-source-owner"
  | "source-and-destination-owners"
  | "artifact-reference-owner"
  | "actor-identity-owner"
  | "actor-endpoint-owner"
  | "blacklist-owner"
  | "channel-grant-owner"
  | "connector-installation-owner";

export type NativeEffectClass =
  | "none"
  | "projection"
  | "resumable-internal"
  | "external"
  | "reconciliation";
export type BusObservationClass = "none" | "post-commit-lossy";

export type ConditionalBatchTransitionEmissionV1 = {
  readonly kind: "conditional-batch";
  readonly sourceRunEventTypes: readonly string[];
  readonly sourceNonRunEventTypes: readonly string[];
};
export type TransitionEmissionV1 =
  | { readonly kind: "batch"; readonly eventTypes: readonly string[] }
  | ConditionalBatchTransitionEmissionV1
  | { readonly kind: "no-commit"; readonly reason: "receipt-idempotent" | "terminal-rejected" }
  | {
      readonly kind: "cross-owner";
      readonly sourceEventTypes: readonly string[];
      readonly destinationEventTypes: readonly string[];
      readonly settlementEventTypes: readonly string[];
    };

export interface NativeTransitionCatalogRowV1 {
  readonly id: NativeTransitionId;
  readonly command: string;
  readonly emission: TransitionEmissionV1;
  readonly ownerDerivation: OwnerDerivationClass;
  readonly expectedHeadAssertions: readonly string[];
  readonly readAssertions: readonly string[];
  readonly reducerIds: readonly string[];
  readonly projectionIds: readonly string[];
  readonly effect: {
    readonly class: NativeEffectClass;
    readonly driverId: string | null;
    readonly reconcilerId: string | null;
  };
  readonly busObservation: BusObservationClass;
  readonly callerReplacement: string;
  readonly testReceiptId: `TC-${NativeTransitionId}`;
}
export interface ConfigurationOperationCatalogRowV1
  extends Omit<NativeTransitionCatalogRowV1, "id" | "testReceiptId"> {
  readonly id: ConfigurationOperationId;
  readonly testReceiptId: `TC-${ConfigurationOperationId}`;
}

export type ClosedOperationCatalogRowV1 =
  | NativeTransitionCatalogRowV1
  | ConfigurationOperationCatalogRowV1;

type RowInput = Omit<NativeTransitionCatalogRowV1, "testReceiptId" | "busObservation">;

const VERSIONED_TYPE = /^[a-z][a-z0-9_.-]*\.v[1-9][0-9]*$/;
const COMMAND_PREFIX: Readonly<Record<NativeTransitionFamily, string>> = Object.freeze({
  SS: "messaging.session.",
  SF: "messaging.surface.",
  MS: "messaging.message.",
  RT: "kernel.route.",
  DP: "kernel.dispatch.",
  WI: "kernel.work.",
  CP: "kernel.completion.",
  AT: "kernel.attempt.",
  WT: "kernel.wait.",
  GR: "kernel.grant.",
  SC: "kernel.schedule.",
  XD: "kernel.cross_owner.",
  EF: "kernel.effect.",
});

const batch = (...eventTypes: string[]): TransitionEmissionV1 => ({ kind: "batch", eventTypes });
const conditionalBatch = (
  sourceRunEventTypes: string[],
  sourceNonRunEventTypes: string[],
): TransitionEmissionV1 => ({
  kind: "conditional-batch",
  sourceRunEventTypes,
  sourceNonRunEventTypes,
});
const noCommit = (reason: "receipt-idempotent" | "terminal-rejected"): TransitionEmissionV1 => ({
  kind: "no-commit",
  reason,
});
const crossOwner = (
  sourceEventTypes: string[],
  destinationEventTypes: string[],
  settlementEventTypes: string[],
): TransitionEmissionV1 => ({
  kind: "cross-owner",
  sourceEventTypes,
  destinationEventTypes,
  settlementEventTypes,
});

function row(input: RowInput, busObservation: BusObservationClass): NativeTransitionCatalogRowV1 {
  const emission: TransitionEmissionV1 =
    input.emission.kind === "batch"
      ? Object.freeze({ kind: "batch", eventTypes: Object.freeze([...input.emission.eventTypes]) })
      : input.emission.kind === "conditional-batch"
        ? Object.freeze({
            kind: "conditional-batch",
            sourceRunEventTypes: Object.freeze([...input.emission.sourceRunEventTypes]),
            sourceNonRunEventTypes: Object.freeze([...input.emission.sourceNonRunEventTypes]),
          })
        : input.emission.kind === "no-commit"
          ? Object.freeze({ ...input.emission })
          : Object.freeze({
              kind: "cross-owner",
              sourceEventTypes: Object.freeze([...input.emission.sourceEventTypes]),
              destinationEventTypes: Object.freeze([...input.emission.destinationEventTypes]),
              settlementEventTypes: Object.freeze([...input.emission.settlementEventTypes]),
            });
  return Object.freeze({
    ...input,
    emission,
    expectedHeadAssertions: Object.freeze([...input.expectedHeadAssertions]),
    readAssertions: Object.freeze([...input.readAssertions]),
    reducerIds: Object.freeze([...input.reducerIds]),
    projectionIds: Object.freeze([...input.projectionIds]),
    effect: Object.freeze({ ...input.effect }),
    busObservation,
    testReceiptId: `TC-${input.id}`,
  });
}

const N = { class: "none", driverId: null, reconcilerId: null } as const;
const P = { class: "projection", driverId: null, reconcilerId: null } as const;
const R = (driverId: string, reconcilerId: string) =>
  ({ class: "resumable-internal", driverId, reconcilerId }) as const;
const E = (driverId: string, reconcilerId: string) =>
  ({ class: "external", driverId, reconcilerId }) as const;
const REC = {
  class: "reconciliation",
  driverId: null,
  reconcilerId: "effect.reconciler.v1",
} as const;

const REGISTERED_RECONCILER_IDS: readonly string[] = Object.freeze([
  "resident.run.v1.reconciler.v1",
  "wait.disambiguate.v1.reconciler.v1",
  "wait.delivery.v1.reconciler.v1",
  "coordinator.message.v1.reconciler.v1",
  "coordinator.spawn.v1.reconciler.v1",
  "coordinator.cancel.v1.reconciler.v1",
  "schedule.delivery.v1.reconciler.v1",
  "connector.submit.v1.reconciler.v1",
  "completion.readback.v1.reconciler.v1",
  "actor.delivery.v1.reconciler.v1",
  "external.submit.v1.reconciler.v1",
  "a2a.submit.v1.reconciler.v1",
  "api.submit.v1.reconciler.v1",
  "device.submit.v1.reconciler.v1",
  "cross-owner.delivery.v1.reconciler.v1",
  "effect.reconciler.v1",
]);

const SESSION_HEAD = ["expected session owner head"] as const;
const WORK_HEAD = ["expected work owner head"] as const;
const ATTEMPT_HEAD = ["expected attempt owner head"] as const;
const WAIT_HEAD = ["expected Wait owner head"] as const;
const ROUTE_READS = [
  "authority source refs at exact projection sequence",
  "surface binding rechecked",
] as const;
const WORK_REDUCERS = ["work-reducer-v1"] as const;
const WORK_PROJECTIONS = ["work_projection"] as const;
const ATTEMPT_REDUCERS = ["attempt-reducer-v1"] as const;
const ATTEMPT_PROJECTIONS = ["attempt_projection"] as const;
const WAIT_REDUCERS = ["wait-reducer-v1"] as const;
const WAIT_PROJECTIONS = ["wait_projection"] as const;

type EventOwnershipV1 = {
  readonly reducerId: string;
  readonly projectionId: string | null;
};

/** Closed event census. Every emitted event must name its owning reducer and projection, when any. */
const EVENT_OWNERSHIP_BY_TYPE: Readonly<Record<string, EventOwnershipV1>> = Object.freeze({
  "session.opened.v1": { reducerId: "session-reducer-v1", projectionId: "session_projection" },
  "session.metadata_revised.v1": {
    reducerId: "session-reducer-v1",
    projectionId: "session_projection",
  },
  "session.closed.v1": { reducerId: "session-reducer-v1", projectionId: "session_projection" },
  "session.expired.v1": { reducerId: "session-reducer-v1", projectionId: "session_projection" },
  "surface.bound.v1": {
    reducerId: "surface-binding-reducer-v1",
    projectionId: "surface_binding_projection",
  },
  "surface.rebound.v1": {
    reducerId: "surface-binding-reducer-v1",
    projectionId: "surface_binding_projection",
  },
  "surface.unbound.v1": {
    reducerId: "surface-binding-reducer-v1",
    projectionId: "surface_binding_projection",
  },
  "kernel.route.decided.v1": { reducerId: "route-reducer-v1", projectionId: null },
  "message.inbound_recorded.v1": {
    reducerId: "message-reducer-v1",
    projectionId: "message_projection",
  },
  "message.assistant_started.v1": {
    reducerId: "message-reducer-v1",
    projectionId: "message_projection",
  },
  "message.status_changed.v1": {
    reducerId: "message-reducer-v1",
    projectionId: "message_projection",
  },
  "message.part_appended.v1": { reducerId: "part-reducer-v1", projectionId: "part_projection" },
  "message.part_revised.v1": { reducerId: "part-reducer-v1", projectionId: "part_projection" },
  "effect.intent.v1": { reducerId: "effect-reducer-v1", projectionId: "effect_projection" },
  "effect.confirmed.v1": { reducerId: "effect-reducer-v1", projectionId: "effect_projection" },
  "effect.definite_failed.v1": {
    reducerId: "effect-reducer-v1",
    projectionId: "effect_projection",
  },
  "effect.unknown.v1": { reducerId: "effect-reducer-v1", projectionId: "effect_projection" },
  "effect.manually_resolved.v1": {
    reducerId: "effect-reducer-v1",
    projectionId: "effect_projection",
  },
  "dispatch.pending.v1": {
    reducerId: "dispatch-reducer-v1",
    projectionId: "dispatch_projection",
  },
  "dispatch.received.v1": {
    reducerId: "dispatch-reducer-v1",
    projectionId: "dispatch_projection",
  },
  "dispatch.delivered.v1": {
    reducerId: "dispatch-reducer-v1",
    projectionId: "dispatch_projection",
  },
  "dispatch.decision.v1": {
    reducerId: "dispatch-reducer-v1",
    projectionId: "dispatch_projection",
  },
  "dispatch.failed.v1": { reducerId: "dispatch-reducer-v1", projectionId: "dispatch_projection" },
  "work.created.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.metadata_revised.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.criteria_revised.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.dependencies_replaced.v1": {
    reducerId: "work-reducer-v1",
    projectionId: "work_projection",
  },
  "work.started.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.evidence_recorded.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.readback_evidence_recorded.v1": {
    reducerId: "work-reducer-v1",
    projectionId: "work_projection",
  },
  "work.blocker_added.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.blocker_resolved.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.failed.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.cancelled.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.retry_exhausted.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.outcome_recorded.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.archived.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.assignment_changed.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.deadline_changed.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "work.completed.v1": { reducerId: "work-reducer-v1", projectionId: "work_projection" },
  "attempt.allocated.v1": { reducerId: "attempt-reducer-v1", projectionId: "attempt_projection" },
  "attempt.start_requested.v1": {
    reducerId: "attempt-reducer-v1",
    projectionId: "attempt_projection",
  },
  "attempt.running.v1": { reducerId: "attempt-reducer-v1", projectionId: "attempt_projection" },
  "attempt.start_failed.v1": {
    reducerId: "attempt-reducer-v1",
    projectionId: "attempt_projection",
  },
  "attempt.cancelled.v1": { reducerId: "attempt-reducer-v1", projectionId: "attempt_projection" },
  "attempt.interrupted.v1": {
    reducerId: "attempt-reducer-v1",
    projectionId: "attempt_projection",
  },
  "attempt.waiting.v1": { reducerId: "attempt-reducer-v1", projectionId: "attempt_projection" },
  "attempt.succeeded.v1": { reducerId: "attempt-reducer-v1", projectionId: "attempt_projection" },
  "attempt.failed.v1": { reducerId: "attempt-reducer-v1", projectionId: "attempt_projection" },
  "wait.opened.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.response_recorded.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.resolved.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.ambiguity_recorded.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.ambiguity_selected.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.follow_up_recorded.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.cancelled.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.expired.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.reminder_requested.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.resume_requested.v1": { reducerId: "wait-reducer-v1", projectionId: "wait_projection" },
  "wait.follow_up_window_closed.v1": {
    reducerId: "wait-reducer-v1",
    projectionId: "wait_projection",
  },
  "completion.candidate.submitted.v1": {
    reducerId: "completion-reducer-v1",
    projectionId: "completion_projection",
  },
  "completion.readback_requested.v1": {
    reducerId: "completion-reducer-v1",
    projectionId: "completion_projection",
  },
  "completion.claim_verdict_recorded.v1": {
    reducerId: "completion-reducer-v1",
    projectionId: "completion_projection",
  },
  "completion.candidate_rejected.v1": {
    reducerId: "completion-reducer-v1",
    projectionId: "completion_projection",
  },
  "completion.decision_recorded.v1": {
    reducerId: "completion-reducer-v1",
    projectionId: "completion_projection",
  },
  "schedule.fire_due.v1": { reducerId: "schedule-reducer-v1", projectionId: "schedule_projection" },
  "schedule.created.v1": { reducerId: "schedule-reducer-v1", projectionId: "schedule_projection" },
  "schedule.advanced.v1": { reducerId: "schedule-reducer-v1", projectionId: "schedule_projection" },
  "schedule.cancelled.v1": {
    reducerId: "schedule-reducer-v1",
    projectionId: "schedule_projection",
  },
  "schedule.fire_settled.v1": {
    reducerId: "schedule-reducer-v1",
    projectionId: "schedule_projection",
  },
  "grant.created.v1": { reducerId: "grant-reducer-v1", projectionId: "worker_grant_projection" },
  "grant.revoked.v1": { reducerId: "grant-reducer-v1", projectionId: "worker_grant_projection" },
  "grant.expired.v1": { reducerId: "grant-reducer-v1", projectionId: "worker_grant_projection" },
  "grant.revised.v1": { reducerId: "grant-reducer-v1", projectionId: "worker_grant_projection" },
});

export const NATIVE_TRANSITION_CATALOG_R9: readonly NativeTransitionCatalogRowV1[] = Object.freeze([
  row(
    {
      id: "SS-01",
      command: "messaging.session.open.v1",
      emission: batch("session.opened.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: ["genesis head"],
      readAssertions: ["session-open semantic request id is unused or receipt-identical"],
      reducerIds: ["session-reducer-v1"],
      projectionIds: ["session_projection"],
      effect: P,
      callerReplacement: "Session.create",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "SS-02",
      command: "messaging.session.open_child.v1",
      emission: batch("session.opened.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: ["child genesis head", "foreign parent head exact"],
      readAssertions: ["native parent-open event ref exists and matches parent head"],
      reducerIds: ["session-reducer-v1"],
      projectionIds: ["session_projection"],
      effect: P,
      callerReplacement: "Session.createChild",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "SS-03",
      command: "messaging.session.revise_metadata.v1",
      emission: batch("session.metadata_revised.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["exact metadata revision", "patch keys limited to title/model/workerMeta"],
      reducerIds: ["session-reducer-v1"],
      projectionIds: ["session_projection"],
      effect: P,
      callerReplacement: "Session.update",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "SS-04",
      command: "messaging.session.close.v1",
      emission: batch("session.closed.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["session is open"],
      reducerIds: ["session-reducer-v1"],
      projectionIds: ["session_projection"],
      effect: P,
      callerReplacement: "Session.remove",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "SS-05",
      command: "messaging.session.expire.v1",
      emission: batch("session.expired.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["database time is strictly greater than expiresAt"],
      reducerIds: ["session-reducer-v1"],
      projectionIds: ["session_projection"],
      effect: P,
      callerReplacement: "session expiry scan",
    },
    "post-commit-lossy",
  ),

  row(
    {
      id: "SF-01",
      command: "messaging.surface.bind.v1",
      emission: batch("session.opened.v1", "surface.bound.v1"),
      ownerDerivation: "surface-session-owner",
      expectedHeadAssertions: ["target session genesis or exact head", "binding version 0/unbound"],
      readAssertions: ["canonical surface semantic key is unbound"],
      reducerIds: ["session-reducer-v1", "surface-binding-reducer-v1"],
      projectionIds: ["session_projection", "surface_binding_projection"],
      effect: P,
      callerReplacement: "SurfaceKey.register",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "SF-02",
      command: "messaging.surface.rebind.v1",
      emission: batch("surface.rebound.v1"),
      ownerDerivation: "surface-session-owner",
      expectedHeadAssertions: ["target session head exact"],
      readAssertions: ["current session and binding version exact"],
      reducerIds: ["surface-binding-reducer-v1"],
      projectionIds: ["surface_binding_projection"],
      effect: P,
      callerReplacement: "SurfaceKey.rebind",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "SF-03",
      command: "messaging.surface.unbind.v1",
      emission: batch("surface.unbound.v1"),
      ownerDerivation: "surface-session-owner",
      expectedHeadAssertions: ["current session head exact"],
      readAssertions: ["current binding exact; absent is receipt-idempotent"],
      reducerIds: ["surface-binding-reducer-v1"],
      projectionIds: ["surface_binding_projection"],
      effect: P,
      callerReplacement: "SurfaceKey.remove",
    },
    "post-commit-lossy",
  ),

  row(
    {
      id: "MS-01",
      command: "messaging.message.record_inbound.v1",
      emission: batch(
        "kernel.route.decided.v1",
        "message.inbound_recorded.v1",
        "message.part_appended.v1",
        "message.status_changed.v1",
        "effect.intent.v1",
      ),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["transport request dedupe exact", ...ROUTE_READS],
      reducerIds: [
        "route-reducer-v1",
        "message-reducer-v1",
        "part-reducer-v1",
        "effect-reducer-v1",
      ],
      projectionIds: ["message_projection", "part_projection", "effect_projection"],
      effect: E("resident.run.v1", "resident.run.v1.reconciler.v1"),
      callerReplacement: "IngressEventProjector and Resident ingress",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "MS-02",
      command: "messaging.message.start_assistant.v1",
      emission: batch("message.assistant_started.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["authenticated session/run/attempt binding", "parent message exists"],
      reducerIds: ["message-reducer-v1"],
      projectionIds: ["message_projection"],
      effect: P,
      callerReplacement: "assistant message creation",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "MS-03",
      command: "messaging.message.append_part.v1",
      emission: batch("message.part_appended.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: [
        "message is open",
        "part ordinal is contiguous",
        "part id/type is immutable",
      ],
      reducerIds: ["part-reducer-v1"],
      projectionIds: ["part_projection"],
      effect: P,
      callerReplacement: "Message.addPart",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "MS-04",
      command: "messaging.message.revise_part.v1",
      emission: batch("message.part_revised.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["exact prior part revision", "kind-specific revision edge is legal"],
      reducerIds: ["part-reducer-v1"],
      projectionIds: ["part_projection"],
      effect: P,
      callerReplacement: "Message.updatePart",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "MS-05",
      command: "messaging.message.change_status.v1",
      emission: batch("message.status_changed.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["status edge is monotonic", "no part follows terminal status"],
      reducerIds: ["message-reducer-v1"],
      projectionIds: ["message_projection"],
      effect: P,
      callerReplacement: "Message.update status",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "MS-06",
      command: "messaging.message.finish_assistant.v1",
      emission: batch(
        "message.assistant_started.v1",
        "message.part_appended.v1",
        "message.part_revised.v1",
        "message.status_changed.v1",
        "message.status_changed.v1",
      ),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: [
        "ordered part revisions exact",
        "all referenced tool/effect outcomes terminal",
        "parent inbound is nonterminal",
      ],
      reducerIds: ["message-reducer-v1", "part-reducer-v1"],
      projectionIds: ["message_projection", "part_projection"],
      effect: P,
      callerReplacement: "resident/worker writeback",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "MS-07",
      command: "messaging.message.recover.v1",
      emission: batch("message.status_changed.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: [
        "original message ids retained",
        "only legal continuation or terminal edge",
        "no raw channel replay",
      ],
      reducerIds: ["message-reducer-v1"],
      projectionIds: ["message_projection"],
      effect: P,
      callerReplacement: "server message recovery",
    },
    "post-commit-lossy",
  ),

  row(
    {
      id: "RT-01",
      command: "kernel.route.blacklist_deny.v1",
      emission: batch("kernel.route.decided.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["absolute blacklist source ref exact"],
      reducerIds: ["route-reducer-v1"],
      projectionIds: [],
      effect: N,
      callerReplacement: "ingress blacklist branch",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "RT-02",
      command: "kernel.route.stage_wait_ambiguity.v1",
      emission: batch("kernel.route.decided.v1", "wait.ambiguity_recorded.v1"),
      ownerDerivation: "surface-session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["candidate ids sorted", "cross-owner candidates are not guessed"],
      reducerIds: ["route-reducer-v1", "wait-reducer-v1"],
      projectionIds: ["wait_projection"],
      effect: R("wait.disambiguate.v1", "wait.disambiguate.v1.reconciler.v1"),
      callerReplacement: "PendingAsk/PendingInteraction ambiguous route",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "RT-03",
      command: "kernel.route.accept_report_result.v1",
      emission: crossOwner(
        [
          "kernel.route.decided.v1",
          "wait.response_recorded.v1",
          "wait.resolved.v1",
          "dispatch.pending.v1",
        ],
        ["dispatch.received.v1", "attempt.succeeded.v1", "completion.candidate.submitted.v1"],
        ["dispatch.delivered.v1"],
      ),
      ownerDerivation: "source-and-destination-owners",
      expectedHeadAssertions: ["Wait source and work destination heads exact"],
      readAssertions: [
        "sender/correlation/action exact",
        "threshold cardinality evaluated after unique response",
        "exactly one delivery",
      ],
      reducerIds: [
        "route-reducer-v1",
        "wait-reducer-v1",
        "dispatch-reducer-v1",
        "attempt-reducer-v1",
        "completion-reducer-v1",
      ],
      projectionIds: [
        "wait_projection",
        "dispatch_projection",
        "attempt_projection",
        "completion_projection",
      ],
      effect: R("wait.delivery.v1", "wait.delivery.v1.reconciler.v1"),
      callerReplacement: "PendingInteraction report_result",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "RT-04",
      command: "kernel.route.accept_clarification.v1",
      emission: crossOwner(
        [
          "kernel.route.decided.v1",
          "wait.response_recorded.v1",
          "wait.resolved.v1",
          "dispatch.pending.v1",
        ],
        ["dispatch.received.v1", "effect.intent.v1"],
        ["dispatch.delivered.v1"],
      ),
      ownerDerivation: "source-and-destination-owners",
      expectedHeadAssertions: ["Wait source and Resident destination heads exact"],
      readAssertions: [
        "sender/correlation/action exact",
        "threshold cardinality evaluated after unique response",
        "exactly one delivery",
      ],
      reducerIds: [
        "route-reducer-v1",
        "wait-reducer-v1",
        "dispatch-reducer-v1",
        "effect-reducer-v1",
      ],
      projectionIds: ["wait_projection", "dispatch_projection", "effect_projection"],
      effect: E("resident.run.v1", "resident.run.v1.reconciler.v1"),
      callerReplacement: "PendingInteraction ask_clarification",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "RT-05",
      command: "kernel.route.accept_wait_response.v1",
      emission: batch(
        "kernel.route.decided.v1",
        "wait.response_recorded.v1",
        "wait.resolved.v1",
        "effect.intent.v1",
      ),
      ownerDerivation: "wait-owner",
      expectedHeadAssertions: WAIT_HEAD,
      readAssertions: [
        "transport id/hash dedupe",
        "first threshold only",
        "same-owner delivery intent exactly once",
      ],
      reducerIds: ["route-reducer-v1", "wait-reducer-v1", "effect-reducer-v1"],
      projectionIds: ["wait_projection", "effect_projection"],
      effect: R("wait.delivery.v1", "wait.delivery.v1.reconciler.v1"),
      callerReplacement: "PendingAsk response correlation",
    },
    "post-commit-lossy",
  ),
  ...(
    [
      ["RT-06", "unsupported_action"],
      ["RT-07", "missing_system_identity"],
      ["RT-08", "missing_channel_grant"],
      ["RT-09", "missing_actor"],
      ["RT-10", "missing_default_authority"],
    ] as const
  ).map(([id, name]) =>
    row(
      {
        id,
        command: `kernel.route.${name}.v1`,
        emission: batch("kernel.route.decided.v1"),
        ownerDerivation: "session-owner",
        expectedHeadAssertions: SESSION_HEAD,
        readAssertions: [`${name} fail-closed fact exact`],
        reducerIds: ["route-reducer-v1"],
        projectionIds: [],
        effect: N,
        callerReplacement: `ingress ${name} branch`,
      },
      "post-commit-lossy",
    ),
  ),
  row(
    {
      id: "RT-11",
      command: "kernel.route.existing_resident.v1",
      emission: batch(
        "kernel.route.decided.v1",
        "message.inbound_recorded.v1",
        "message.part_appended.v1",
        "message.status_changed.v1",
        "effect.intent.v1",
      ),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["transport dedupe", ...ROUTE_READS],
      reducerIds: [
        "route-reducer-v1",
        "message-reducer-v1",
        "part-reducer-v1",
        "effect-reducer-v1",
      ],
      projectionIds: ["message_projection", "part_projection", "effect_projection"],
      effect: E("resident.run.v1", "resident.run.v1.reconciler.v1"),
      callerReplacement: "existing Resident ingress",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "RT-12",
      command: "kernel.route.new_resident.v1",
      emission: batch(
        "session.opened.v1",
        "surface.bound.v1",
        "kernel.route.decided.v1",
        "message.inbound_recorded.v1",
        "message.part_appended.v1",
        "message.status_changed.v1",
        "effect.intent.v1",
      ),
      ownerDerivation: "surface-session-owner",
      expectedHeadAssertions: ["new session genesis", "binding v0/unbound"],
      readAssertions: ["deterministic ids", "binding assertion", "transport dedupe"],
      reducerIds: [
        "session-reducer-v1",
        "surface-binding-reducer-v1",
        "route-reducer-v1",
        "message-reducer-v1",
        "part-reducer-v1",
        "effect-reducer-v1",
      ],
      projectionIds: [
        "session_projection",
        "surface_binding_projection",
        "message_projection",
        "part_projection",
        "effect_projection",
      ],
      effect: E("resident.run.v1", "resident.run.v1.reconciler.v1"),
      callerReplacement: "new Resident ingress",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "RT-13",
      command: "kernel.route.active_worker.v1",
      emission: crossOwner(
        [
          "kernel.route.decided.v1",
          "message.inbound_recorded.v1",
          "message.part_appended.v1",
          "message.status_changed.v1",
          "dispatch.pending.v1",
        ],
        ["dispatch.received.v1", "effect.intent.v1"],
        ["dispatch.delivered.v1"],
      ),
      ownerDerivation: "source-and-destination-owners",
      expectedHeadAssertions: ["session source and Attempt destination heads exact"],
      readAssertions: ["attempt active", "stable delivery id"],
      reducerIds: [
        "route-reducer-v1",
        "message-reducer-v1",
        "part-reducer-v1",
        "dispatch-reducer-v1",
        "effect-reducer-v1",
      ],
      projectionIds: [
        "message_projection",
        "part_projection",
        "dispatch_projection",
        "effect_projection",
      ],
      effect: R("coordinator.message.v1", "coordinator.message.v1.reconciler.v1"),
      callerReplacement: "active Worker ingress",
    },
    "post-commit-lossy",
  ),
  ...(
    [
      ["RT-14", "foreground_worker"],
      ["RT-15", "background_worker"],
    ] as const
  ).map(([id, name]) =>
    row(
      {
        id,
        command: `kernel.route.new_${name}.v1`,
        emission: crossOwner(
          [
            "kernel.route.decided.v1",
            "message.inbound_recorded.v1",
            "message.part_appended.v1",
            "message.status_changed.v1",
            "dispatch.pending.v1",
          ],
          ["dispatch.received.v1", "work.created.v1", "attempt.allocated.v1", "effect.intent.v1"],
          ["dispatch.delivered.v1"],
        ),
        ownerDerivation: "source-and-destination-owners",
        expectedHeadAssertions: ["session source and work destination heads exact"],
        readAssertions: [
          "Resident authority",
          "deterministic work/attempt ids",
          ...(name === "background_worker" ? ["background returns only after source commit"] : []),
        ],
        reducerIds: [
          "route-reducer-v1",
          "message-reducer-v1",
          "part-reducer-v1",
          "dispatch-reducer-v1",
          "work-reducer-v1",
          "attempt-reducer-v1",
          "effect-reducer-v1",
        ],
        projectionIds: [
          "message_projection",
          "part_projection",
          "dispatch_projection",
          "work_projection",
          "attempt_projection",
          "effect_projection",
        ],
        effect: R("coordinator.spawn.v1", "coordinator.spawn.v1.reconciler.v1"),
        callerReplacement: `new ${name} ingress`,
      },
      "post-commit-lossy",
    ),
  ),
  row(
    {
      id: "RT-16",
      command: "kernel.route.stop_or_cancel.v1",
      emission: crossOwner(
        ["kernel.route.decided.v1", "dispatch.pending.v1"],
        ["dispatch.received.v1", "dispatch.decision.v1", "effect.intent.v1"],
        ["dispatch.delivered.v1"],
      ),
      ownerDerivation: "source-and-destination-owners",
      expectedHeadAssertions: ["source and each destination head exact"],
      readAssertions: ["pending records sorted", "no direct attempt mutation"],
      reducerIds: ["route-reducer-v1", "dispatch-reducer-v1", "effect-reducer-v1"],
      projectionIds: ["dispatch_projection", "effect_projection"],
      effect: R("coordinator.cancel.v1", "coordinator.cancel.v1.reconciler.v1"),
      callerReplacement: "ingress stop/cancel handler",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "RT-17",
      command: "kernel.route.schedule_fire.v1",
      emission: crossOwner(
        ["schedule.fire_due.v1", "dispatch.pending.v1"],
        ["dispatch.received.v1", "kernel.route.decided.v1", "effect.intent.v1"],
        ["dispatch.delivered.v1"],
      ),
      ownerDerivation: "source-and-destination-owners",
      expectedHeadAssertions: ["schedule source and route destination heads exact"],
      readAssertions: [
        "due generation CAS",
        "database time at or after nextFireAt",
        "transient outcome remains pending",
      ],
      reducerIds: [
        "schedule-reducer-v1",
        "dispatch-reducer-v1",
        "route-reducer-v1",
        "effect-reducer-v1",
      ],
      projectionIds: ["schedule_projection", "dispatch_projection", "effect_projection"],
      effect: R("schedule.delivery.v1", "schedule.delivery.v1.reconciler.v1"),
      callerReplacement: "CronJobRunner direct ingress",
    },
    "post-commit-lossy",
  ),

  row(
    {
      id: "DP-01",
      command: "kernel.dispatch.deny.v1",
      emission: batch("dispatch.decision.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["authority source refs exact", "handler not invoked"],
      reducerIds: ["dispatch-reducer-v1"],
      projectionIds: ["dispatch_projection"],
      effect: N,
      callerReplacement: "DispatchRuntime deny",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-02",
      command: "kernel.dispatch.pending.v1",
      emission: batch("dispatch.decision.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["authority source refs exact", "handler not invoked while pending"],
      reducerIds: ["dispatch-reducer-v1"],
      projectionIds: ["dispatch_projection"],
      effect: N,
      callerReplacement: "DispatchRuntime pending",
    },
    "post-commit-lossy",
  ),
  ...(
    [
      ["DP-03", "unsupported_actor_message"],
      ["DP-04", "unknown_action"],
    ] as const
  ).map(([id, name]) =>
    row(
      {
        id,
        command: `kernel.dispatch.${name}.v1`,
        emission: batch("dispatch.decision.v1"),
        ownerDerivation: "session-owner",
        expectedHeadAssertions: SESSION_HEAD,
        readAssertions: ["unsupported action exact", "no semantic reuse"],
        reducerIds: ["dispatch-reducer-v1"],
        projectionIds: ["dispatch_projection"],
        effect: N,
        callerReplacement: `DispatchRuntime ${name}`,
      },
      "post-commit-lossy",
    ),
  ),
  row(
    {
      id: "DP-05",
      command: "kernel.dispatch.spawn_worker.v1",
      emission: batch(
        "dispatch.decision.v1",
        "work.created.v1",
        "attempt.allocated.v1",
        "effect.intent.v1",
      ),
      ownerDerivation: "work-owner",
      expectedHeadAssertions: ["work genesis head"],
      readAssertions: ["Resident-only authority", "criteria and policy frozen"],
      reducerIds: [
        "dispatch-reducer-v1",
        "work-reducer-v1",
        "attempt-reducer-v1",
        "effect-reducer-v1",
      ],
      projectionIds: [
        "dispatch_projection",
        "work_projection",
        "attempt_projection",
        "effect_projection",
      ],
      effect: R("coordinator.spawn.v1", "coordinator.spawn.v1.reconciler.v1"),
      callerReplacement: "worker.spawn handler",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-06",
      command: "kernel.dispatch.connector_submit.v1",
      emission: batch("dispatch.decision.v1", "effect.intent.v1"),
      ownerDerivation: "work-owner",
      expectedHeadAssertions: WORK_HEAD,
      readAssertions: ["installation enabled/consented", "installation version/source ref exact"],
      reducerIds: ["dispatch-reducer-v1", "effect-reducer-v1"],
      projectionIds: ["dispatch_projection", "effect_projection"],
      effect: E("connector.submit.v1", "connector.submit.v1.reconciler.v1"),
      callerReplacement: "connector submit handler",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-07",
      command: "kernel.dispatch.submit_completion.v1",
      emission: batch(
        "dispatch.decision.v1",
        "attempt.succeeded.v1",
        "completion.candidate.submitted.v1",
      ),
      ownerDerivation: "work-owner",
      expectedHeadAssertions: WORK_HEAD,
      readAssertions: [
        "immutable exact claims",
        "current criteria revision",
        "candidate stakes snapshot exact",
      ],
      reducerIds: ["dispatch-reducer-v1", "attempt-reducer-v1", "completion-reducer-v1"],
      projectionIds: ["dispatch_projection", "attempt_projection", "completion_projection"],
      effect: P,
      callerReplacement: "worker.complete",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-08",
      command: "kernel.dispatch.submit_completion_readback.v1",
      emission: batch(
        "dispatch.decision.v1",
        "attempt.succeeded.v1",
        "completion.candidate.submitted.v1",
        "completion.readback_requested.v1",
        "effect.intent.v1",
      ),
      ownerDerivation: "work-owner",
      expectedHeadAssertions: WORK_HEAD,
      readAssertions: [
        "immutable exact claims",
        "GET/HEAD request frozen",
        "verifier and stakes refs frozen",
      ],
      reducerIds: [
        "dispatch-reducer-v1",
        "attempt-reducer-v1",
        "completion-reducer-v1",
        "effect-reducer-v1",
      ],
      projectionIds: [
        "dispatch_projection",
        "attempt_projection",
        "completion_projection",
        "effect_projection",
      ],
      effect: E("completion.readback.v1", "completion.readback.v1.reconciler.v1"),
      callerReplacement: "worker completion readback",
    },
    "post-commit-lossy",
  ),
  ...(
    [
      ["DP-09", "cancel_work", "work.cancelled.v1"],
      ["DP-10", "fail_work", "work.failed.v1"],
      ["DP-11", "interrupt_attempt", "attempt.interrupted.v1"],
    ] as const
  ).map(([id, name, terminalEvent]) =>
    row(
      {
        id,
        command: `kernel.dispatch.${name}.v1`,
        emission: batch("dispatch.decision.v1", terminalEvent),
        ownerDerivation: "work-owner",
        expectedHeadAssertions: WORK_HEAD,
        readAssertions: ["terminal CAS", "terminal repeat receipt-idempotent"],
        reducerIds:
          id === "DP-11"
            ? ["dispatch-reducer-v1", "attempt-reducer-v1"]
            : ["dispatch-reducer-v1", "work-reducer-v1"],
        projectionIds:
          id === "DP-11"
            ? ["dispatch_projection", "attempt_projection"]
            : ["dispatch_projection", "work_projection"],
        effect: P,
        callerReplacement: `dispatch ${name}`,
      },
      "post-commit-lossy",
    ),
  ),
  row(
    {
      id: "DP-12",
      command: "kernel.dispatch.message_worker.v1",
      emission: crossOwner(
        ["dispatch.decision.v1", "dispatch.pending.v1"],
        ["dispatch.received.v1", "effect.intent.v1"],
        ["dispatch.delivered.v1"],
      ),
      ownerDerivation: "source-and-destination-owners",
      expectedHeadAssertions: ["source and target heads exact"],
      readAssertions: ["target active", "grant and policy refs exact"],
      reducerIds: ["dispatch-reducer-v1", "effect-reducer-v1"],
      projectionIds: ["dispatch_projection", "effect_projection"],
      effect: R("coordinator.message.v1", "coordinator.message.v1.reconciler.v1"),
      callerReplacement: "worker.send",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-13",
      command: "kernel.dispatch.resume_wait.v1",
      emission: batch("dispatch.decision.v1", "wait.resume_requested.v1", "effect.intent.v1"),
      ownerDerivation: "attempt-derived-work-owner",
      expectedHeadAssertions: ATTEMPT_HEAD,
      readAssertions: ["Wait resolved", "stable delivery id"],
      reducerIds: ["dispatch-reducer-v1", "wait-reducer-v1", "effect-reducer-v1"],
      projectionIds: ["dispatch_projection", "wait_projection", "effect_projection"],
      effect: R("coordinator.message.v1", "coordinator.message.v1.reconciler.v1"),
      callerReplacement: "worker.resume",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-14",
      command: "kernel.dispatch.ensure_cancel.v1",
      emission: batch("dispatch.decision.v1", "effect.intent.v1"),
      ownerDerivation: "attempt-derived-work-owner",
      expectedHeadAssertions: ATTEMPT_HEAD,
      readAssertions: ["active attempt or terminal idempotent result"],
      reducerIds: ["dispatch-reducer-v1", "effect-reducer-v1"],
      projectionIds: ["dispatch_projection", "effect_projection"],
      effect: R("coordinator.cancel.v1", "coordinator.cancel.v1.reconciler.v1"),
      callerReplacement: "worker.cancel",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-15",
      command: "kernel.dispatch.ask_resident.v1",
      emission: conditionalBatch(
        ["wait.opened.v1", "dispatch.pending.v1", "attempt.waiting.v1"],
        ["wait.opened.v1", "dispatch.pending.v1"],
      ),
      ownerDerivation: "attempt-derived-work-owner",
      expectedHeadAssertions: ATTEMPT_HEAD,
      readAssertions: [
        "source-run opens Wait and dispatch pending before atomic attempt suspension",
        "source-non-run opens Wait and dispatch pending without attempt suspension",
      ],
      reducerIds: ["wait-reducer-v1", "dispatch-reducer-v1", "attempt-reducer-v1"],
      projectionIds: ["wait_projection", "dispatch_projection", "attempt_projection"],
      effect: P,
      callerReplacement: "resident.ask/PendingAsk",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-16",
      command: "kernel.dispatch.accept_response.v1",
      emission: batch(
        "dispatch.decision.v1",
        "wait.response_recorded.v1",
        "wait.resolved.v1",
        "effect.intent.v1",
      ),
      ownerDerivation: "wait-owner",
      expectedHeadAssertions: WAIT_HEAD,
      readAssertions: [
        "unique response map cardinality",
        "delivery only at first threshold",
        "C0-C5 crash receipt",
      ],
      reducerIds: ["dispatch-reducer-v1", "wait-reducer-v1", "effect-reducer-v1"],
      projectionIds: ["dispatch_projection", "wait_projection", "effect_projection"],
      effect: R("wait.delivery.v1", "wait.delivery.v1.reconciler.v1"),
      callerReplacement: "PendingAsk/PendingInteraction response selector",
    },
    "post-commit-lossy",
  ),
  ...(
    [
      [
        "DP-17",
        "actor_fire_and_forget",
        batch("dispatch.decision.v1", "effect.intent.v1"),
        "session-owner",
      ],
      [
        "DP-18",
        "actor_awaited",
        crossOwner(
          ["dispatch.decision.v1", "wait.opened.v1", "dispatch.pending.v1"],
          ["dispatch.received.v1", "effect.intent.v1"],
          ["dispatch.delivered.v1"],
        ),
        "source-and-destination-owners",
      ],
    ] as const
  ).map(([id, name, emission, ownerDerivation]) =>
    row(
      {
        id,
        command: `kernel.dispatch.${name}.v1`,
        emission,
        ownerDerivation,
        expectedHeadAssertions: ["source and any destination heads exact"],
        readAssertions: ["existing actor target", "zero WorkItem/Attempt allocation"],
        reducerIds:
          id === "DP-18"
            ? ["dispatch-reducer-v1", "wait-reducer-v1", "effect-reducer-v1"]
            : ["dispatch-reducer-v1", "effect-reducer-v1"],
        projectionIds:
          id === "DP-18"
            ? ["dispatch_projection", "wait_projection", "effect_projection"]
            : ["dispatch_projection", "effect_projection"],
        effect: E("actor.delivery.v1", "actor.delivery.v1.reconciler.v1"),
        callerReplacement: `dispatch ${name}`,
      },
      "post-commit-lossy",
    ),
  ),
  ...(
    [
      ["DP-19", "external_submit", E("external.submit.v1", "external.submit.v1.reconciler.v1")],
      ["DP-20", "a2a_submit", E("a2a.submit.v1", "a2a.submit.v1.reconciler.v1")],
      ["DP-21", "api_submit", E("api.submit.v1", "api.submit.v1.reconciler.v1")],
    ] as const
  ).map(([id, name, effect]) =>
    row(
      {
        id,
        command: `kernel.dispatch.${name}.v1`,
        emission: batch("dispatch.decision.v1", "effect.intent.v1"),
        ownerDerivation: "session-owner",
        expectedHeadAssertions: SESSION_HEAD,
        readAssertions: ["endpoint exact", "driver/reconciler version registered"],
        reducerIds: ["dispatch-reducer-v1", "effect-reducer-v1"],
        projectionIds: ["dispatch_projection", "effect_projection"],
        effect,
        callerReplacement: `dispatch ${name}`,
      },
      "post-commit-lossy",
    ),
  ),
  row(
    {
      id: "DP-22",
      command: "kernel.dispatch.device_submit.v1",
      emission: batch("dispatch.decision.v1", "effect.intent.v1"),
      ownerDerivation: "session-owner",
      expectedHeadAssertions: SESSION_HEAD,
      readAssertions: ["system target exact", "risk and device resolver exact"],
      reducerIds: ["dispatch-reducer-v1", "effect-reducer-v1"],
      projectionIds: ["dispatch_projection", "effect_projection"],
      effect: E("device.submit.v1", "device.submit.v1.reconciler.v1"),
      callerReplacement: "device dispatch handler",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-23",
      command: "kernel.dispatch.schedule_create.v1",
      emission: batch("dispatch.decision.v1", "schedule.created.v1", "schedule.advanced.v1"),
      ownerDerivation: "schedule-owner",
      expectedHeadAssertions: ["schedule genesis head"],
      readAssertions: ["schedule version 1", "next UTC fire deterministic"],
      reducerIds: ["dispatch-reducer-v1", "schedule-reducer-v1"],
      projectionIds: ["dispatch_projection", "schedule_projection"],
      effect: P,
      callerReplacement: "schedule.create",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "DP-24",
      command: "kernel.dispatch.schedule_cancel.v1",
      emission: batch("dispatch.decision.v1", "schedule.cancelled.v1"),
      ownerDerivation: "schedule-owner",
      expectedHeadAssertions: ["schedule head exact"],
      readAssertions: ["schedule version exact"],
      reducerIds: ["dispatch-reducer-v1", "schedule-reducer-v1"],
      projectionIds: ["dispatch_projection", "schedule_projection"],
      effect: P,
      callerReplacement: "schedule.cancel",
    },
    "post-commit-lossy",
  ),

  ...(
    [
      [
        "WI-01",
        "create",
        ["work.created.v1"],
        ["work genesis head"],
        [
          "nonempty criteria",
          "immutable source/session/origin/executor/retry/dependencies",
          "work genesis; parent proof/head when present",
        ],
      ],
      [
        "WI-02",
        "revise_metadata",
        ["work.metadata_revised.v1"],
        WORK_HEAD,
        ["patch keys exactly name/intent/goal/context/constraints/changedFiles"],
      ],
      [
        "WI-03",
        "revise_criteria",
        ["work.criteria_revised.v1"],
        WORK_HEAD,
        ["criteria revision exact"],
      ],
      [
        "WI-04",
        "replace_dependencies",
        ["work.dependencies_replaced.v1"],
        WORK_HEAD,
        ["one projection checkpoint exact"],
      ],
      ["WI-05", "start", ["work.started.v1"], WORK_HEAD, ["allocated attempt exists"]],
      [
        "WI-06",
        "record_evidence",
        ["work.evidence_recorded.v1"],
        WORK_HEAD,
        ["immutable evidence id/hash"],
      ],
      [
        "WI-07",
        "record_readback",
        ["work.readback_evidence_recorded.v1"],
        WORK_HEAD,
        ["immutable readback and effect ref"],
      ],
      ["WI-08", "add_blocker", ["work.blocker_added.v1"], WORK_HEAD, ["unique active blocker"]],
      [
        "WI-09",
        "resolve_blocker",
        ["work.blocker_resolved.v1"],
        WORK_HEAD,
        ["active blocker exact"],
      ],
      ["WI-10", "fail", ["work.failed.v1"], WORK_HEAD, ["nonterminal work"]],
      ["WI-11", "cancel", ["work.cancelled.v1"], WORK_HEAD, ["nonterminal work"]],
      [
        "WI-12",
        "retry",
        ["attempt.allocated.v1", "work.started.v1"],
        WORK_HEAD,
        ["retryOf prior terminal attempt and retry budget"],
      ],
      [
        "WI-13",
        "exhaust_retry",
        ["work.retry_exhausted.v1", "work.blocker_added.v1"],
        WORK_HEAD,
        ["retry budget exhausted and blocker appended"],
      ],
      [
        "WI-14",
        "record_outcome",
        ["work.outcome_recorded.v1"],
        WORK_HEAD,
        ["attempt terminal and outcome immutable"],
      ],
      [
        "WI-15",
        "archive",
        ["work.archived.v1"],
        WORK_HEAD,
        ["no active nonterminal dependent; child lineage retained"],
      ],
      ["WI-16", "assign", ["work.assignment_changed.v1"], WORK_HEAD, ["assignee authority exact"]],
      [
        "WI-17",
        "set_deadline",
        ["work.deadline_changed.v1"],
        WORK_HEAD,
        ["deadline version and DB-time basis exact"],
      ],
    ] as const
  ).map(([id, name, eventTypes, expectedHeadAssertions, readAssertions]) =>
    row(
      {
        id,
        command: `kernel.work.${name}.v1`,
        emission: batch(...eventTypes),
        ownerDerivation: "work-owner",
        expectedHeadAssertions,
        readAssertions,
        reducerIds: id === "WI-12" ? [...WORK_REDUCERS, ...ATTEMPT_REDUCERS] : WORK_REDUCERS,
        projectionIds:
          id === "WI-12" ? [...WORK_PROJECTIONS, ...ATTEMPT_PROJECTIONS] : WORK_PROJECTIONS,
        effect: P,
        callerReplacement: `WorkItemStore ${name}`,
      },
      "post-commit-lossy",
    ),
  ),

  row(
    {
      id: "CP-01",
      command: "kernel.completion.submit_candidate.v1",
      emission: batch("completion.candidate.submitted.v1"),
      ownerDerivation: "work-owner",
      expectedHeadAssertions: WORK_HEAD,
      readAssertions: [
        "candidate immutable",
        "exact criteria/claim coverage",
        "stakes as-of ledger sequence and DB time frozen",
      ],
      reducerIds: ["completion-reducer-v1"],
      projectionIds: ["completion_projection"],
      effect: P,
      callerReplacement: "completion candidate store",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "CP-02",
      command: "kernel.completion.record_verdict.v1",
      emission: batch("completion.claim_verdict_recorded.v1"),
      ownerDerivation: "work-owner",
      expectedHeadAssertions: WORK_HEAD,
      readAssertions: ["one terminal verdict per exact claim", "kernel verifier id/version exact"],
      reducerIds: ["completion-reducer-v1"],
      projectionIds: ["completion_projection"],
      effect: P,
      callerReplacement: "VerifierRegistry result",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "CP-03",
      command: "kernel.completion.evaluate.v1",
      emission: batch("completion.candidate_rejected.v1"),
      ownerDerivation: "work-owner",
      expectedHeadAssertions: WORK_HEAD,
      readAssertions: [
        "AC-1..AC-6 total table",
        "refutation wins over pending",
        "high-stakes asserted escalates",
      ],
      reducerIds: ["completion-reducer-v1"],
      projectionIds: ["completion_projection"],
      effect: P,
      callerReplacement: "work.complete.pre gate",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "CP-04",
      command: "kernel.completion.admit.v1",
      emission: batch("completion.decision_recorded.v1", "work.completed.v1"),
      ownerDerivation: "work-owner",
      expectedHeadAssertions: WORK_HEAD,
      readAssertions: [
        "complete terminal claim coverage",
        "verifier refs exact",
        "stakes threshold rule satisfied",
      ],
      reducerIds: ["completion-reducer-v1", "work-reducer-v1"],
      projectionIds: ["completion_projection", "work_projection"],
      effect: P,
      callerReplacement: "WorkItemStore.complete",
    },
    "post-commit-lossy",
  ),

  ...(
    [
      [
        "AT-01",
        "allocate",
        ["attempt.allocated.v1"],
        "retry policy and executor binding exact",
        ATTEMPT_REDUCERS,
        ATTEMPT_PROJECTIONS,
        P,
      ],
      [
        "AT-02",
        "request_start",
        ["attempt.start_requested.v1", "effect.intent.v1"],
        "attempt allocated",
        [...ATTEMPT_REDUCERS, "effect-reducer-v1"],
        [...ATTEMPT_PROJECTIONS, "effect_projection"],
        R("coordinator.spawn.v1", "coordinator.spawn.v1.reconciler.v1"),
      ],
      [
        "AT-03",
        "confirm_running",
        ["effect.confirmed.v1", "attempt.running.v1"],
        "confirmed start or resume effect exact; attempt remains non-running before confirmation",
        [...ATTEMPT_REDUCERS, "effect-reducer-v1"],
        [...ATTEMPT_PROJECTIONS, "effect_projection"],
        P,
      ],
      [
        "AT-04",
        "start_failed",
        ["effect.definite_failed.v1", "attempt.start_failed.v1"],
        "definite start no-materialization proof",
        [...ATTEMPT_REDUCERS, "effect-reducer-v1"],
        [...ATTEMPT_PROJECTIONS, "effect_projection"],
        P,
      ],
      [
        "AT-05",
        "confirm_cancel",
        ["effect.confirmed.v1", "attempt.cancelled.v1"],
        "cancel effect exact",
        [...ATTEMPT_REDUCERS, "effect-reducer-v1"],
        [...ATTEMPT_PROJECTIONS, "effect_projection"],
        P,
      ],
      [
        "AT-06",
        "interrupt_starting",
        ["attempt.interrupted.v1"],
        "boot sees starting without materialized process",
        ATTEMPT_REDUCERS,
        ATTEMPT_PROJECTIONS,
        P,
      ],
      [
        "AT-07",
        "wait",
        ["attempt.waiting.v1", "wait.opened.v1"],
        "one open Wait and atomic suspension",
        [...ATTEMPT_REDUCERS, ...WAIT_REDUCERS],
        [...ATTEMPT_PROJECTIONS, ...WAIT_PROJECTIONS],
        P,
      ],
      [
        "AT-08",
        "succeed",
        ["attempt.succeeded.v1"],
        "running attempt",
        ATTEMPT_REDUCERS,
        ATTEMPT_PROJECTIONS,
        P,
      ],
      [
        "AT-09",
        "fail",
        ["attempt.failed.v1"],
        "running attempt",
        ATTEMPT_REDUCERS,
        ATTEMPT_PROJECTIONS,
        P,
      ],
      [
        "AT-10",
        "cancel_running",
        ["attempt.cancelled.v1"],
        "running attempt",
        ATTEMPT_REDUCERS,
        ATTEMPT_PROJECTIONS,
        P,
      ],
      [
        "AT-11",
        "interrupt_running",
        ["attempt.interrupted.v1"],
        "boot confirms process absent",
        ATTEMPT_REDUCERS,
        ATTEMPT_PROJECTIONS,
        P,
      ],
      [
        "AT-12",
        "resume",
        ["wait.resume_requested.v1", "effect.intent.v1"],
        "resolved Wait records resume intent; attempt remains waiting until confirmed settlement",
        [...WAIT_REDUCERS, "effect-reducer-v1"],
        [...WAIT_PROJECTIONS, "effect_projection"],
        R("coordinator.message.v1", "coordinator.message.v1.reconciler.v1"),
      ],
      [
        "AT-13",
        "fail_waiting",
        ["effect.definite_failed.v1", "attempt.failed.v1"],
        "waiting attempt and exact resume delivery failure settlement",
        [...ATTEMPT_REDUCERS, "effect-reducer-v1"],
        [...ATTEMPT_PROJECTIONS, "effect_projection"],
        P,
      ],
      [
        "AT-14",
        "cancel_waiting",
        ["wait.cancelled.v1", "attempt.cancelled.v1"],
        "Wait and attempt cancel atomically",
        [...ATTEMPT_REDUCERS, ...WAIT_REDUCERS],
        [...ATTEMPT_PROJECTIONS, ...WAIT_PROJECTIONS],
        P,
      ],
      [
        "AT-15",
        "interrupt_waiting",
        ["attempt.interrupted.v1"],
        "Wait remains durable and unchanged",
        ATTEMPT_REDUCERS,
        ATTEMPT_PROJECTIONS,
        P,
      ],
    ] as const
  ).map(([id, name, eventTypes, assertion, reducerIds, projectionIds, effect]) =>
    row(
      {
        id,
        command: `kernel.attempt.${name}.v1`,
        emission: batch(...eventTypes),
        ownerDerivation: "attempt-derived-work-owner",
        expectedHeadAssertions: ATTEMPT_HEAD,
        readAssertions: [assertion],
        reducerIds,
        projectionIds,
        effect,
        callerReplacement: `WorkerRun ${name}`,
      },
      "post-commit-lossy",
    ),
  ),

  ...(
    [
      [
        "WT-01",
        "open",
        batch("wait.opened.v1"),
        "expected responders/actions/quorum valid",
        P,
        "post-commit-lossy",
      ],
      [
        "WT-02",
        "record_below_quorum",
        batch("wait.response_recorded.v1"),
        "unique transport id; cardinality below threshold",
        P,
        "post-commit-lossy",
      ],
      [
        "WT-03",
        "resolve_threshold",
        batch("wait.response_recorded.v1", "wait.resolved.v1", "dispatch.pending.v1"),
        "first threshold and exactly one delivery",
        P,
        "post-commit-lossy",
      ],
      [
        "WT-04",
        "record_duplicate",
        noCommit("receipt-idempotent"),
        "same transport id/hash is receipt-idempotent; different hash rejects",
        P,
        "none",
      ],
      [
        "WT-05",
        "stage_ambiguity",
        batch("wait.ambiguity_recorded.v1"),
        "sorted candidates at surface owner",
        P,
        "post-commit-lossy",
      ],
      [
        "WT-06",
        "select_ambiguity",
        batch("wait.ambiguity_selected.v1"),
        "selection revalidates candidate and authority",
        P,
        "post-commit-lossy",
      ],
      [
        "WT-07",
        "record_follow_up",
        batch("wait.follow_up_recorded.v1"),
        "resolved Wait in open follow-up window",
        P,
        "post-commit-lossy",
      ],
      ["WT-08", "cancel", batch("wait.cancelled.v1"), "open Wait", P, "post-commit-lossy"],
      [
        "WT-09",
        "expire",
        batch("wait.expired.v1"),
        "DB time strictly greater than deadline",
        P,
        "post-commit-lossy",
      ],
      [
        "WT-10",
        "resolve_partial",
        batch("wait.resolved.v1"),
        "partial allowed and DB time strictly greater than deadline",
        P,
        "post-commit-lossy",
      ],
      [
        "WT-11",
        "reject_late",
        noCommit("terminal-rejected"),
        "terminal Wait does not mutate",
        P,
        "none",
      ],
      [
        "WT-12",
        "remind",
        batch("wait.reminder_requested.v1", "effect.intent.v1"),
        "open Wait reminder policy",
        R("wait.delivery.v1", "wait.delivery.v1.reconciler.v1"),
        "post-commit-lossy",
      ],
      [
        "WT-13",
        "resume",
        batch("wait.resume_requested.v1", "effect.intent.v1"),
        "resolved Wait and stable delivery",
        R("wait.delivery.v1", "wait.delivery.v1.reconciler.v1"),
        "post-commit-lossy",
      ],
      [
        "WT-14",
        "close_followups_empty",
        batch("wait.follow_up_window_closed.v1"),
        "DB time strictly greater than follow-up boundary; no follow-ups",
        P,
        "post-commit-lossy",
      ],
      [
        "WT-15",
        "close_followups_present",
        batch("wait.follow_up_window_closed.v1"),
        "DB time strictly greater than follow-up boundary; follow-ups retained",
        P,
        "post-commit-lossy",
      ],
    ] as const
  ).map(([id, name, emission, assertion, effect, busObservation]) =>
    row(
      {
        id,
        command: `kernel.wait.${name}.v1`,
        emission,
        ownerDerivation: "wait-owner",
        expectedHeadAssertions: WAIT_HEAD,
        readAssertions: [assertion, "response threshold uses unique response map cardinality"],
        reducerIds:
          id === "WT-03"
            ? [...WAIT_REDUCERS, "dispatch-reducer-v1"]
            : id === "WT-12" || id === "WT-13"
              ? [...WAIT_REDUCERS, "effect-reducer-v1"]
              : WAIT_REDUCERS,
        projectionIds:
          id === "WT-03"
            ? [...WAIT_PROJECTIONS, "dispatch_projection"]
            : id === "WT-12" || id === "WT-13"
              ? [...WAIT_PROJECTIONS, "effect_projection"]
              : WAIT_PROJECTIONS,
        effect,
        callerReplacement: `Wait/PendingInteraction ${name}`,
      },
      busObservation,
    ),
  ),

  ...(
    [
      ["GR-01", "create", "grant.created.v1", ["grant genesis head"]],
      ["GR-02", "revoke", "grant.revoked.v1", ["grant head exact"]],
      ["GR-03", "expire", "grant.expired.v1", ["grant head exact"]],
      ["GR-04", "revise", "grant.revised.v1", ["grant head exact"]],
    ] as const
  ).map(([id, name, eventType, expectedHeadAssertions]) =>
    row(
      {
        id,
        command: `kernel.grant.${name}.v1`,
        emission: batch(eventType),
        ownerDerivation: "grant-owner",
        expectedHeadAssertions,
        readAssertions: ["integer grant version exact", "Attempt existence/source ref exact"],
        reducerIds: ["grant-reducer-v1"],
        projectionIds: ["worker_grant_projection"],
        effect: P,
        callerReplacement: `WorkerGrantStore ${name}`,
      },
      "post-commit-lossy",
    ),
  ),
  row(
    {
      id: "SC-01",
      command: "kernel.schedule.initialize_or_advance.v1",
      emission: batch("schedule.advanced.v1"),
      ownerDerivation: "schedule-owner",
      expectedHeadAssertions: ["schedule head and generation exact"],
      readAssertions: ["next UTC fire deterministic"],
      reducerIds: ["schedule-reducer-v1"],
      projectionIds: ["schedule_projection"],
      effect: P,
      callerReplacement: "CronJobRegistry create/advance",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "SC-02",
      command: "kernel.schedule.settle_and_advance.v1",
      emission: batch("schedule.fire_settled.v1", "schedule.advanced.v1"),
      ownerDerivation: "schedule-owner",
      expectedHeadAssertions: ["schedule head and due generation exact"],
      readAssertions: ["fire delivered or definite-failed", "unknown/transient remains pending"],
      reducerIds: ["schedule-reducer-v1"],
      projectionIds: ["schedule_projection"],
      effect: P,
      callerReplacement: "CronJobRunner settlement",
    },
    "post-commit-lossy",
  ),

  row(
    {
      id: "XD-01",
      command: "kernel.cross_owner.deliver_pending.v1",
      emission: crossOwner(
        ["dispatch.pending.v1"],
        ["dispatch.received.v1", "effect.intent.v1"],
        ["dispatch.delivered.v1"],
      ),
      ownerDerivation: "source-and-destination-owners",
      expectedHeadAssertions: ["source pending and destination heads exact"],
      readAssertions: [
        "deterministic destination request id",
        "destination receipt before settlement",
      ],
      reducerIds: ["dispatch-reducer-v1", "effect-reducer-v1"],
      projectionIds: ["dispatch_projection", "effect_projection"],
      effect: R("cross-owner.delivery.v1", "cross-owner.delivery.v1.reconciler.v1"),
      callerReplacement: "cross-owner direct mutation",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "XD-02",
      command: "kernel.cross_owner.settle_delivered.v1",
      emission: batch("dispatch.delivered.v1"),
      ownerDerivation: "source-and-destination-owners",
      expectedHeadAssertions: ["source head exact"],
      readAssertions: ["destination receipt exact", "pending record exact"],
      reducerIds: ["dispatch-reducer-v1"],
      projectionIds: ["dispatch_projection"],
      effect: P,
      callerReplacement: "cross-owner success acknowledgement",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "XD-03",
      command: "kernel.cross_owner.settle_definite_failed.v1",
      emission: batch("dispatch.failed.v1"),
      ownerDerivation: "source-and-destination-owners",
      expectedHeadAssertions: ["source head exact"],
      readAssertions: ["definite destination failure proof", "transient remains pending"],
      reducerIds: ["dispatch-reducer-v1"],
      projectionIds: ["dispatch_projection"],
      effect: P,
      callerReplacement: "cross-owner failure acknowledgement",
    },
    "post-commit-lossy",
  ),

  row(
    {
      id: "EF-01",
      command: "kernel.effect.confirm.v1",
      emission: batch("effect.confirmed.v1"),
      ownerDerivation: "effect-source-owner",
      expectedHeadAssertions: ["effect source owner head exact"],
      readAssertions: ["pending intent exact", "driver acknowledgement/idempotency key exact"],
      reducerIds: ["effect-reducer-v1"],
      projectionIds: ["effect_projection"],
      effect: P,
      callerReplacement: "effect success settlement",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "EF-02",
      command: "kernel.effect.fail_definite.v1",
      emission: batch("effect.definite_failed.v1"),
      ownerDerivation: "effect-source-owner",
      expectedHeadAssertions: ["effect source owner head exact"],
      readAssertions: [
        "pending intent exact",
        "no-materialization proof exact",
        "resume attempt remains waiting",
      ],
      reducerIds: ["effect-reducer-v1"],
      projectionIds: ["effect_projection"],
      effect: P,
      callerReplacement: "effect definite failure settlement",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "EF-03",
      command: "kernel.effect.mark_unknown.v1",
      emission: batch("effect.unknown.v1"),
      ownerDerivation: "effect-source-owner",
      expectedHeadAssertions: ["effect source owner head exact"],
      readAssertions: [
        "pending intent exact",
        "ambiguous act or acknowledgement",
        "workspace remains fail-closed",
        "resume attempt remains waiting pending reconciliation",
      ],
      reducerIds: ["effect-reducer-v1"],
      projectionIds: ["effect_projection"],
      effect: REC,
      callerReplacement: "unsafe marker write",
    },
    "post-commit-lossy",
  ),
  row(
    {
      id: "EF-04",
      command: "kernel.effect.resolve_unknown.v1",
      emission: batch("effect.manually_resolved.v1"),
      ownerDerivation: "effect-source-owner",
      expectedHeadAssertions: ["effect source owner head exact"],
      readAssertions: [
        "unknown history retained",
        "Owner identity and evidence exact",
        "no direct clear",
      ],
      reducerIds: ["effect-reducer-v1"],
      projectionIds: ["effect_projection"],
      effect: REC,
      callerReplacement: "WorkspaceLock.clearUnsafe",
    },
    "post-commit-lossy",
  ),
]);

type ConfigurationOperationSpecV1 = {
  readonly id: ConfigurationOperationId;
  readonly command: string;
  readonly eventType: string;
  readonly ownerDerivation: OwnerDerivationClass;
  readonly guard: string;
  readonly reducerId: string;
  readonly projectionId: string;
  readonly callerReplacement: string;
};

const CONFIGURATION_OPERATION_SPECS_V1: readonly ConfigurationOperationSpecV1[] = [
  {
    id: "AF-01",
    command: "artifact.put_and_reference.v1",
    eventType: "artifact.referenced.v1",
    ownerDerivation: "artifact-reference-owner",
    guard:
      "content hash, byte length, and reference id are exact; blob insertion and reference event commit atomically",
    reducerId: "artifact-reference-reducer-v1",
    projectionId: "artifact_reference_projection",
    callerReplacement: "ArtifactBlobStore.put and artifact reference caller",
  },
  {
    id: "AI-01",
    command: "kernel.actor.register_identity.v1",
    eventType: "actor.identity_registered.v1",
    ownerDerivation: "actor-identity-owner",
    guard: "actor identity genesis and canonical actor id are exact",
    reducerId: "actor-identity-reducer-v1",
    projectionId: "actor_identity_projection",
    callerReplacement: "ActorRegistry.register",
  },
  {
    id: "AI-02",
    command: "kernel.actor.revise_identity.v1",
    eventType: "actor.identity_revised.v1",
    ownerDerivation: "actor-identity-owner",
    guard: "actor identity head and revision are exact",
    reducerId: "actor-identity-reducer-v1",
    projectionId: "actor_identity_projection",
    callerReplacement: "ActorRegistry.update",
  },
  {
    id: "AI-03",
    command: "kernel.actor.retire_identity.v1",
    eventType: "actor.identity_retired.v1",
    ownerDerivation: "actor-identity-owner",
    guard: "actor identity is active and retirement is monotonic",
    reducerId: "actor-identity-reducer-v1",
    projectionId: "actor_identity_projection",
    callerReplacement: "ActorRegistry.remove",
  },
  {
    id: "AE-01",
    command: "kernel.actor.bind_endpoint.v1",
    eventType: "actor.endpoint_bound.v1",
    ownerDerivation: "actor-endpoint-owner",
    guard: "endpoint genesis and actor identity source reference are exact",
    reducerId: "actor-endpoint-reducer-v1",
    projectionId: "actor_endpoint_projection",
    callerReplacement: "ActorEndpointStore.bind",
  },
  {
    id: "AE-02",
    command: "kernel.actor.rebind_endpoint.v1",
    eventType: "actor.endpoint_rebound.v1",
    ownerDerivation: "actor-endpoint-owner",
    guard: "endpoint head, current actor, and binding revision are exact",
    reducerId: "actor-endpoint-reducer-v1",
    projectionId: "actor_endpoint_projection",
    callerReplacement: "ActorEndpointStore.rebind",
  },
  {
    id: "AE-03",
    command: "kernel.actor.unbind_endpoint.v1",
    eventType: "actor.endpoint_unbound.v1",
    ownerDerivation: "actor-endpoint-owner",
    guard: "endpoint head and current binding are exact",
    reducerId: "actor-endpoint-reducer-v1",
    projectionId: "actor_endpoint_projection",
    callerReplacement: "ActorEndpointStore.unbind",
  },
  {
    id: "BL-01",
    command: "kernel.authority.create_blacklist.v1",
    eventType: "authority.blacklist_created.v1",
    ownerDerivation: "blacklist-owner",
    guard: "blacklist genesis, subject, and authority source are exact",
    reducerId: "blacklist-reducer-v1",
    projectionId: "blacklist_projection",
    callerReplacement: "BlacklistStore.create",
  },
  {
    id: "BL-02",
    command: "kernel.authority.revise_blacklist.v1",
    eventType: "authority.blacklist_revised.v1",
    ownerDerivation: "blacklist-owner",
    guard: "blacklist head and integer revision are exact",
    reducerId: "blacklist-reducer-v1",
    projectionId: "blacklist_projection",
    callerReplacement: "BlacklistStore.revise",
  },
  {
    id: "BL-03",
    command: "kernel.authority.revoke_blacklist.v1",
    eventType: "authority.blacklist_revoked.v1",
    ownerDerivation: "blacklist-owner",
    guard: "active blacklist head is exact and revocation is monotonic",
    reducerId: "blacklist-reducer-v1",
    projectionId: "blacklist_projection",
    callerReplacement: "BlacklistStore.revoke",
  },
  {
    id: "BL-04",
    command: "kernel.authority.expire_blacklist.v1",
    eventType: "authority.blacklist_expired.v1",
    ownerDerivation: "blacklist-owner",
    guard: "database time is strictly greater than blacklist expiry",
    reducerId: "blacklist-reducer-v1",
    projectionId: "blacklist_projection",
    callerReplacement: "blacklist expiry scan",
  },
  {
    id: "CG-01",
    command: "kernel.authority.create_channel_grant.v1",
    eventType: "authority.channel_grant_created.v1",
    ownerDerivation: "channel-grant-owner",
    guard: "channel grant genesis, principal, surface, and authority source are exact",
    reducerId: "channel-grant-reducer-v1",
    projectionId: "channel_grant_projection",
    callerReplacement: "ChannelGrantStore.create",
  },
  {
    id: "CG-02",
    command: "kernel.authority.revise_channel_grant.v1",
    eventType: "authority.channel_grant_revised.v1",
    ownerDerivation: "channel-grant-owner",
    guard: "channel grant head and integer revision are exact",
    reducerId: "channel-grant-reducer-v1",
    projectionId: "channel_grant_projection",
    callerReplacement: "ChannelGrantStore.revise",
  },
  {
    id: "CG-03",
    command: "kernel.authority.revoke_channel_grant.v1",
    eventType: "authority.channel_grant_revoked.v1",
    ownerDerivation: "channel-grant-owner",
    guard: "active channel grant head is exact and revocation is monotonic",
    reducerId: "channel-grant-reducer-v1",
    projectionId: "channel_grant_projection",
    callerReplacement: "ChannelGrantStore.revoke",
  },
  {
    id: "CI-01",
    command: "kernel.connector.register_installation.v1",
    eventType: "connector.installation_registered.v1",
    ownerDerivation: "connector-installation-owner",
    guard: "installation genesis, connector definition, and Owner authority are exact",
    reducerId: "connector-installation-reducer-v1",
    projectionId: "connector_installation_projection",
    callerReplacement: "AppConnectorInstallationStore.register",
  },
  {
    id: "CI-02",
    command: "kernel.connector.revise_definition.v1",
    eventType: "connector.definition_revised.v1",
    ownerDerivation: "connector-installation-owner",
    guard: "installation head and definition revision are exact",
    reducerId: "connector-installation-reducer-v1",
    projectionId: "connector_installation_projection",
    callerReplacement: "AppConnectorInstallationStore.reviseDefinition",
  },
  {
    id: "CI-03",
    command: "kernel.connector.request_consent.v1",
    eventType: "connector.consent_requested.v1",
    ownerDerivation: "connector-installation-owner",
    guard: "installation enabled and requested permissions are canonical",
    reducerId: "connector-installation-reducer-v1",
    projectionId: "connector_installation_projection",
    callerReplacement: "AppConnectorInstallationStore.requestConsent",
  },
  {
    id: "CI-04",
    command: "kernel.connector.grant_consent.v1",
    eventType: "connector.consent_granted.v1",
    ownerDerivation: "connector-installation-owner",
    guard: "pending consent request, Owner identity, and permissions are exact",
    reducerId: "connector-installation-reducer-v1",
    projectionId: "connector_installation_projection",
    callerReplacement: "AppConnectorInstallationStore.grantConsent",
  },
  {
    id: "CI-05",
    command: "kernel.connector.request_verification.v1",
    eventType: "connector.verification_requested.v1",
    ownerDerivation: "connector-installation-owner",
    guard: "consent and connector definition revisions are exact",
    reducerId: "connector-installation-reducer-v1",
    projectionId: "connector_installation_projection",
    callerReplacement: "AppConnectorInstallationStore.requestVerification",
  },
  {
    id: "CI-06",
    command: "kernel.connector.record_verified.v1",
    eventType: "connector.verified.v1",
    ownerDerivation: "connector-installation-owner",
    guard: "pending verification and verifier evidence are exact",
    reducerId: "connector-installation-reducer-v1",
    projectionId: "connector_installation_projection",
    callerReplacement: "AppConnectorInstallationStore.recordVerified",
  },
  {
    id: "CI-07",
    command: "kernel.connector.record_verification_failed.v1",
    eventType: "connector.verification_failed.v1",
    ownerDerivation: "connector-installation-owner",
    guard: "pending verification and sanitized failure evidence are exact",
    reducerId: "connector-installation-reducer-v1",
    projectionId: "connector_installation_projection",
    callerReplacement: "AppConnectorInstallationStore.recordVerificationFailed",
  },
  {
    id: "CI-08",
    command: "kernel.connector.disable.v1",
    eventType: "connector.disabled.v1",
    ownerDerivation: "connector-installation-owner",
    guard: "installation head is exact and disable is monotonic",
    reducerId: "connector-installation-reducer-v1",
    projectionId: "connector_installation_projection",
    callerReplacement: "AppConnectorInstallationStore.disable",
  },
  {
    id: "CI-09",
    command: "kernel.connector.uninstall.v1",
    eventType: "connector.uninstalled.v1",
    ownerDerivation: "connector-installation-owner",
    guard: "installation head, Owner authority, and terminal edge are exact",
    reducerId: "connector-installation-reducer-v1",
    projectionId: "connector_installation_projection",
    callerReplacement: "AppConnectorInstallationStore.uninstall",
  },
] as const;

export const CONFIGURATION_OPERATION_CATALOG_V1: readonly ConfigurationOperationCatalogRowV1[] =
  Object.freeze(
    CONFIGURATION_OPERATION_SPECS_V1.map((spec) =>
      Object.freeze({
        id: spec.id,
        command: spec.command,
        emission: Object.freeze({
          kind: "batch" as const,
          eventTypes: Object.freeze([spec.eventType]),
        }),
        ownerDerivation: spec.ownerDerivation,
        expectedHeadAssertions: Object.freeze([
          spec.id.endsWith("-01")
            ? "configuration owner genesis head"
            : "expected configuration owner head",
        ]),
        readAssertions: Object.freeze([spec.guard]),
        reducerIds: Object.freeze([spec.reducerId]),
        projectionIds: Object.freeze([spec.projectionId]),
        effect: Object.freeze({ class: "projection" as const, driverId: null, reconcilerId: null }),
        busObservation: "post-commit-lossy" as const,
        callerReplacement: spec.callerReplacement,
        testReceiptId: `TC-${spec.id}` as const,
      }),
    ),
  );

export const CLOSED_OPERATION_CATALOG_V1: readonly ClosedOperationCatalogRowV1[] = Object.freeze([
  ...NATIVE_TRANSITION_CATALOG_R9,
  ...CONFIGURATION_OPERATION_CATALOG_V1,
]);

const CANONICAL_COMMAND_BY_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    NATIVE_TRANSITION_CATALOG_R9.map((catalogRow) => [catalogRow.id, catalogRow.command]),
  ),
);
const CANONICAL_ROW_SERIALIZATION_BY_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    NATIVE_TRANSITION_CATALOG_R9.map((catalogRow) => [catalogRow.id, JSON.stringify(catalogRow)]),
  ),
);

function exactSet(actual: readonly string[], expected: ReadonlySet<string>): boolean {
  return (
    actual.length === expected.size &&
    new Set(actual).size === actual.length &&
    actual.every((value) => expected.has(value))
  );
}

function eventTypes(emission: TransitionEmissionV1): readonly string[] {
  if (emission.kind === "batch") return emission.eventTypes;
  if (emission.kind === "conditional-batch") {
    return [...new Set([...emission.sourceRunEventTypes, ...emission.sourceNonRunEventTypes])];
  }
  if (emission.kind === "no-commit") return [];
  return [
    ...emission.sourceEventTypes,
    ...emission.destinationEventTypes,
    ...emission.settlementEventTypes,
  ];
}

const CATALOG_ROW_KEYS = Object.freeze([
  "id",
  "command",
  "emission",
  "ownerDerivation",
  "expectedHeadAssertions",
  "readAssertions",
  "reducerIds",
  "projectionIds",
  "effect",
  "busObservation",
  "callerReplacement",
  "testReceiptId",
] as const);

export function validateNativeTransitionCatalog(
  rows: readonly NativeTransitionCatalogRowV1[],
): readonly NativeTransitionCatalogRowV1[] {
  const seen = new Set<string>();
  const counts = new Map<NativeTransitionFamily, number>();
  const emittedCensus = new Set<string>();
  for (const row of rows) {
    const match = /^(SS|SF|MS|RT|DP|WI|CP|AT|WT|GR|SC|XD|EF)-([0-9]{2})$/.exec(row.id);
    if (!match) throw new Error(`transition_forbidden: unlisted transition id ${row.id}`);
    const family = match[1] as NativeTransitionFamily;
    const ordinal = Number(match[2]);
    if (ordinal < 1 || ordinal > NATIVE_TRANSITION_FAMILY_CARDINALITIES[family]) {
      throw new Error(`transition_forbidden: out-of-range transition id ${row.id}`);
    }
    if (seen.has(row.id))
      throw new Error(`transition_forbidden: duplicate transition id ${row.id}`);
    seen.add(row.id);
    counts.set(family, (counts.get(family) ?? 0) + 1);
    if (!VERSIONED_TYPE.test(row.command))
      throw new Error(`transition_forbidden: unversioned command ${row.command}`);
    if (!row.command.startsWith(COMMAND_PREFIX[family])) {
      throw new Error(`transition_forbidden: wrong-family command ${row.id} ${row.command}`);
    }
    if (row.command !== CANONICAL_COMMAND_BY_ID[row.id]) {
      throw new Error(`transition_forbidden: noncanonical command ${row.id} ${row.command}`);
    }
    const emitted = eventTypes(row.emission);
    if (
      row.emission.kind === "cross-owner" &&
      (row.emission.sourceEventTypes.length === 0 ||
        row.emission.destinationEventTypes.length === 0 ||
        row.emission.settlementEventTypes.length === 0)
    ) {
      throw new Error(`transition_forbidden: incomplete cross-owner form ${row.id}`);
    }
    if (
      row.emission.kind === "conditional-batch" &&
      (row.emission.sourceRunEventTypes.length === 0 ||
        row.emission.sourceNonRunEventTypes.length === 0)
    ) {
      throw new Error(`transition_forbidden: incomplete conditional-batch form ${row.id}`);
    }
    for (const eventType of emitted) {
      if (!VERSIONED_TYPE.test(eventType))
        throw new Error(`transition_forbidden: unsupported event version ${eventType}`);
      if (!eventType.endsWith(".v1"))
        throw new Error(`transition_forbidden: event version is not v1 ${eventType}`);
      const ownership = EVENT_OWNERSHIP_BY_TYPE[eventType];
      if (!ownership) {
        throw new Error(`transition_forbidden: uncatalogued event ownership ${eventType}`);
      }
      emittedCensus.add(eventType);
      if (
        !row.reducerIds.includes(ownership.reducerId) ||
        (ownership.projectionId !== null && !row.projectionIds.includes(ownership.projectionId))
      ) {
        throw new Error(
          `transition_forbidden: missing reducer/projection event ownership ${row.id} ${eventType}`,
        );
      }
    }
    const expectedReducerIds = new Set<string>();
    const expectedProjectionIds = new Set<string>();
    if (row.emission.kind === "no-commit") {
      expectedReducerIds.add("wait-reducer-v1");
      expectedProjectionIds.add("wait_projection");
    } else {
      for (const eventType of emitted) {
        const ownership = EVENT_OWNERSHIP_BY_TYPE[eventType];
        if (ownership === undefined) {
          throw new Error(
            `transition_forbidden: internal event ownership invariant violated ${row.id} ${eventType}`,
          );
        }
        expectedReducerIds.add(ownership.reducerId);
        if (ownership.projectionId !== null) expectedProjectionIds.add(ownership.projectionId);
      }
    }
    if (
      !exactSet(row.reducerIds, expectedReducerIds) ||
      !exactSet(row.projectionIds, expectedProjectionIds)
    ) {
      throw new Error(`transition_forbidden: noncanonical reducer/projection ownership ${row.id}`);
    }
    if (row.expectedHeadAssertions.length === 0 || row.readAssertions.length === 0) {
      throw new Error(`transition_forbidden: missing assertion ${row.id}`);
    }
    if (row.reducerIds.length === 0) {
      throw new Error(`transition_forbidden: missing reducer/projection ${row.id}`);
    }
    if (row.testReceiptId !== `TC-${row.id}`) {
      throw new Error(`transition_forbidden: invalid receipt ${row.id}`);
    }
    const effectHasDriver = row.effect.driverId !== null;
    const effectHasReconciler = row.effect.reconcilerId !== null;
    if (
      (row.effect.class === "none" || row.effect.class === "projection") &&
      (effectHasDriver || effectHasReconciler)
    ) {
      throw new Error(`transition_forbidden: invalid effect binding ${row.id}`);
    }
    if (
      (row.effect.class === "resumable-internal" || row.effect.class === "external") &&
      (!effectHasDriver || !effectHasReconciler)
    ) {
      throw new Error(`transition_forbidden: incomplete effect binding ${row.id}`);
    }
    if (row.effect.class === "reconciliation" && (effectHasDriver || !effectHasReconciler)) {
      throw new Error(`transition_forbidden: invalid reconciliation binding ${row.id}`);
    }
    if (
      row.effect.reconcilerId !== null &&
      !REGISTERED_RECONCILER_IDS.includes(row.effect.reconcilerId)
    ) {
      throw new Error(`transition_forbidden: unregistered reconciler ${row.id}`);
    }
    if (
      Object.keys(row).length !== CATALOG_ROW_KEYS.length ||
      CATALOG_ROW_KEYS.some((key) => Object.getOwnPropertyDescriptor(row, key) === undefined) ||
      row.callerReplacement.length === 0 ||
      (row.busObservation !== "none" && row.busObservation !== "post-commit-lossy")
    ) {
      throw new Error(`transition_forbidden: catalog row mismatch ${row.id}`);
    }
    if (JSON.stringify(row) !== CANONICAL_ROW_SERIALIZATION_BY_ID[row.id]) {
      throw new Error(`transition_forbidden: catalog row mismatch ${row.id}`);
    }
  }
  for (const [family, cardinality] of Object.entries(NATIVE_TRANSITION_FAMILY_CARDINALITIES)) {
    if ((counts.get(family as NativeTransitionFamily) ?? 0) !== cardinality) {
      throw new Error(`transition_forbidden: ${family} cardinality must be ${cardinality}`);
    }
  }
  if (seen.size !== 120) throw new Error(`transition_forbidden: catalog cardinality must be 120`);
  const ownershipCensus = Object.keys(EVENT_OWNERSHIP_BY_TYPE);
  if (
    emittedCensus.size !== ownershipCensus.length ||
    ownershipCensus.some((eventType) => !emittedCensus.has(eventType))
  ) {
    throw new Error("transition_forbidden: event ownership census mismatch");
  }
  return rows;
}

validateNativeTransitionCatalog(NATIVE_TRANSITION_CATALOG_R9);

const CATALOG_BY_ID = new Map(NATIVE_TRANSITION_CATALOG_R9.map((entry) => [entry.id, entry]));

export function nativeTransitionById(id: string): NativeTransitionCatalogRowV1 {
  const transition = CATALOG_BY_ID.get(id as NativeTransitionId);
  if (!transition) throw new Error(`transition_forbidden: ${id}`);
  return transition;
}
