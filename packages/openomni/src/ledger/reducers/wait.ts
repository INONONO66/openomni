import type { Ledger, Wait } from "@openomni/protocol";

export interface WaitDispatchPendingV1 {
  readonly version: "wait-dispatch-pending-v1";
  readonly eventType: "dispatch.pending.v1";
  readonly waitId: string;
  readonly dispatchId: string;
  readonly kind: "threshold_settlement";
  readonly responseEventIds: readonly string[];
  readonly createdAtDbMs: number;
}

export interface WaitEffectIntentV1 {
  readonly version: "wait-effect-intent-v1";
  readonly eventType: "effect.intent.v1";
  readonly waitId: string;
  readonly effectId: string;
  readonly kind: "reminder" | "resume";
  readonly createdAtDbMs: number;
}

export type WaitProjectionEventV1 =
  | Wait.LifecycleEventV1
  | WaitDispatchPendingV1
  | WaitEffectIntentV1;

export interface StoredWaitProjectionEventV1 {
  readonly eventId: string;
  readonly event: WaitProjectionEventV1;
}

export interface RecordedWaitResponseV1 {
  readonly eventId: string;
  readonly event: Wait.ResponseRecordedV1;
}

export interface RecordedWaitFollowUpV1 {
  readonly eventId: string;
  readonly event: Wait.FollowUpRecordedV1;
}

export interface WaitProjectionV1 {
  readonly waitId: string | null;
  readonly ownerRef: Wait.OwnerRefV1 | null;
  readonly status: "absent" | Wait.StatusV1;
  readonly opened: Wait.OpenedV1 | null;
  readonly responsesByTransportId: ReadonlyMap<string, RecordedWaitResponseV1>;
  readonly responseEventIds: readonly string[];
  readonly resolution: Wait.ResolvedV1 | null;
  readonly terminalEventId: string | null;
  readonly ambiguitiesByEventId: ReadonlyMap<string, Wait.AmbiguityRecordedV1>;
  readonly selectedAmbiguityEventIds: ReadonlySet<string>;
  readonly followUpsByTransportId: ReadonlyMap<string, RecordedWaitFollowUpV1>;
  readonly followUpEventIds: readonly string[];
  readonly followUpsClosedAtDbMs: number | null;
  readonly remindersByResponder: ReadonlyMap<string, number>;
  readonly resumeEventIds: readonly string[];
  readonly pendingDispatches: readonly WaitDispatchPendingV1[];
  readonly effectIntents: readonly WaitEffectIntentV1[];
}

export class WaitReducerError extends Error {
  constructor(readonly reason: string) {
    super(`wait reducer rejected event: ${reason}`);
    this.name = "WaitReducerError";
  }
}

function emptyProjection(): WaitProjectionV1 {
  return {
    waitId: null,
    ownerRef: null,
    status: "absent",
    opened: null,
    responsesByTransportId: new Map(),
    responseEventIds: [],
    resolution: null,
    terminalEventId: null,
    ambiguitiesByEventId: new Map(),
    selectedAmbiguityEventIds: new Set(),
    followUpsByTransportId: new Map(),
    followUpEventIds: [],
    followUpsClosedAtDbMs: null,
    remindersByResponder: new Map(),
    resumeEventIds: [],
    pendingDispatches: [],
    effectIntents: [],
  };
}

function responderKey(responder: Wait.ResponderRefV1): string {
  return `${responder.actorId}\0${responder.endpointId ?? ""}`;
}

function sameOwner(left: Wait.OwnerRefV1 | null, right: Wait.OwnerRefV1): boolean {
  return left !== null && left.kind === right.kind && left.id === right.id;
}

function copy(state: WaitProjectionV1): {
  responses: Map<string, RecordedWaitResponseV1>;
  ambiguities: Map<string, Wait.AmbiguityRecordedV1>;
  selections: Set<string>;
  followUps: Map<string, RecordedWaitFollowUpV1>;
  reminders: Map<string, number>;
} {
  return {
    responses: new Map(state.responsesByTransportId),
    ambiguities: new Map(state.ambiguitiesByEventId),
    selections: new Set(state.selectedAmbiguityEventIds),
    followUps: new Map(state.followUpsByTransportId),
    reminders: new Map(state.remindersByResponder),
  };
}

function assertBound(
  state: WaitProjectionV1,
  event: { waitId: string; ownerRef: Wait.OwnerRefV1 },
): void {
  if (state.waitId !== event.waitId || !sameOwner(state.ownerRef, event.ownerRef)) {
    throw new WaitReducerError("wait_identity_mismatch");
  }
}

export interface WaitReducerV1 {
  readonly initial: () => WaitProjectionV1;
  readonly reduce: (
    state: WaitProjectionV1,
    stored: StoredWaitProjectionEventV1,
  ) => WaitProjectionV1;
  readonly fold: (events: readonly StoredWaitProjectionEventV1[]) => WaitProjectionV1;
}

export function createWaitReducer(): WaitReducerV1 {
  function reduce(state: WaitProjectionV1, stored: StoredWaitProjectionEventV1): WaitProjectionV1 {
    if (stored.eventId.length === 0) throw new WaitReducerError("missing_event_id");
    const event = stored.event;
    const maps = copy(state);

    if (event.version === "wait.opened.v1") {
      if (state.status !== "absent") throw new WaitReducerError("wait_already_opened");
      return {
        ...emptyProjection(),
        waitId: event.waitId,
        ownerRef: event.ownerRef,
        status: "open",
        opened: event,
      };
    }
    if (event.version === "wait-dispatch-pending-v1") {
      if (
        state.waitId !== event.waitId ||
        state.status !== "resolved" ||
        state.pendingDispatches.some((pending) => pending.dispatchId === event.dispatchId)
      ) {
        throw new WaitReducerError("invalid_or_duplicate_dispatch");
      }
      return { ...state, pendingDispatches: [...state.pendingDispatches, event] };
    }
    if (event.version === "wait-effect-intent-v1") {
      if (
        state.waitId !== event.waitId ||
        state.effectIntents.some((intent) => intent.effectId === event.effectId)
      ) {
        throw new WaitReducerError("duplicate_effect_intent");
      }
      return { ...state, effectIntents: [...state.effectIntents, event] };
    }

    assertBound(state, event);
    if (event.version === "wait.response_recorded.v1") {
      if (state.status !== "open") throw new WaitReducerError("response_for_terminal_wait");
      const prior = maps.responses.get(event.transportId);
      if (prior !== undefined) {
        if (prior.event.responseHash === event.responseHash) return state;
        throw new WaitReducerError("transport_digest_conflict");
      }
      maps.responses.set(event.transportId, { eventId: stored.eventId, event });
      return {
        ...state,
        responsesByTransportId: maps.responses,
        responseEventIds: [...state.responseEventIds, stored.eventId],
      };
    }
    if (event.version === "wait.resolved.v1") {
      if (state.status !== "open") throw new WaitReducerError("wait_not_open");
      if (event.responseEventIds.some((id) => !state.responseEventIds.includes(id))) {
        throw new WaitReducerError("unknown_resolution_response");
      }
      return { ...state, status: "resolved", resolution: event, terminalEventId: stored.eventId };
    }
    if (event.version === "wait.cancelled.v1") {
      if (state.status !== "open") throw new WaitReducerError("wait_not_open");
      return { ...state, status: "cancelled", terminalEventId: stored.eventId };
    }
    if (event.version === "wait.expired.v1") {
      if (state.status !== "open") throw new WaitReducerError("wait_not_open");
      return { ...state, status: "expired", terminalEventId: stored.eventId };
    }
    if (event.version === "wait.ambiguity_recorded.v1") {
      if (state.status === "absent") throw new WaitReducerError("wait_not_opened");
      maps.ambiguities.set(stored.eventId, event);
      return { ...state, ambiguitiesByEventId: maps.ambiguities };
    }
    if (event.version === "wait.ambiguity_selected.v1") {
      const ambiguity = maps.ambiguities.get(event.ambiguityEventId);
      if (ambiguity === undefined || !ambiguity.candidateWaitIds.includes(event.selectedWaitId)) {
        throw new WaitReducerError("invalid_ambiguity_selection");
      }
      maps.selections.add(event.ambiguityEventId);
      return { ...state, selectedAmbiguityEventIds: maps.selections };
    }
    if (event.version === "wait.follow_up_recorded.v1") {
      if (state.status !== "resolved" || state.followUpsClosedAtDbMs !== null) {
        throw new WaitReducerError("follow_up_window_closed");
      }
      const prior = maps.followUps.get(event.transportId);
      if (prior !== undefined) {
        if (prior.event.responseHash === event.responseHash) return state;
        throw new WaitReducerError("transport_digest_conflict");
      }
      maps.followUps.set(event.transportId, { eventId: stored.eventId, event });
      return {
        ...state,
        followUpsByTransportId: maps.followUps,
        followUpEventIds: [...state.followUpEventIds, stored.eventId],
      };
    }
    if (event.version === "wait.reminder_requested.v1") {
      if (state.status !== "open") throw new WaitReducerError("wait_not_open");
      maps.reminders.set(responderKey(event.responder), event.reminderOrdinal);
      return { ...state, remindersByResponder: maps.reminders };
    }
    if (event.version === "wait.resume_requested.v1") {
      if (state.status !== "resolved") throw new WaitReducerError("wait_not_resolved");
      return { ...state, resumeEventIds: [...state.resumeEventIds, stored.eventId] };
    }
    if (event.version === "wait.follow_up_window_closed.v1") {
      if (state.status !== "resolved") throw new WaitReducerError("wait_not_resolved");
      return { ...state, followUpsClosedAtDbMs: event.closedAtDbMs };
    }
    if (
      event.version === "wait.response_selected.v1" ||
      event.version === "wait.partial_deadline.v1" ||
      event.version === "wait.late_rejected.v1"
    ) {
      return state;
    }
    const exhaustive: never = event;
    throw new WaitReducerError(`unsupported_event:${String(exhaustive)}`);
  }

  return Object.freeze({
    initial: emptyProjection,
    reduce,
    fold(events: readonly StoredWaitProjectionEventV1[]) {
      return events.reduce(reduce, emptyProjection());
    },
  });
}

export type WaitAttemptRefV1 = Ledger.AttemptRefV1;
