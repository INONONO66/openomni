import { Wait } from "@openomni/protocol";
import {
  createWaitReducer,
  type StoredWaitProjectionEventV1,
  type WaitDispatchPendingV1,
  type WaitEffectIntentV1,
  type WaitProjectionV1,
  type WaitProjectionEventV1,
} from "../reducers/wait.js";

interface CommandBaseV1 {
  readonly operationId: `WT-${string}`;
  readonly requestId: string;
  readonly observedAtDbMs: number;
}

interface ResponseFactsV1 {
  readonly responder: Wait.ResponderRefV1;
  readonly transportId: string;
  readonly responseDigest: string;
  readonly action: Wait.AllowedActionV1;
  readonly payloadRef: string;
}

export type WaitTransitionCommandV1 =
  | (CommandBaseV1 & { readonly operationId: "WT-01"; readonly opened: Wait.OpenedV1 })
  | (CommandBaseV1 & { readonly operationId: "WT-02"; readonly response: ResponseFactsV1 })
  | (CommandBaseV1 & { readonly operationId: "WT-03"; readonly response: ResponseFactsV1 })
  | (CommandBaseV1 & {
      readonly operationId: "WT-04";
      readonly transportId: string;
      readonly responseDigest: string;
    })
  | (CommandBaseV1 & {
      readonly operationId: "WT-05";
      readonly candidateWaitIds: readonly string[];
      readonly transportId: string;
      readonly responseDigest: string;
    })
  | (CommandBaseV1 & {
      readonly operationId: "WT-06";
      readonly ambiguityEventId: string;
      readonly selectedWaitId: string;
      readonly authorityRevalidated: boolean;
    })
  | (CommandBaseV1 & {
      readonly operationId: "WT-07";
      readonly response: Omit<ResponseFactsV1, "action">;
    })
  | (CommandBaseV1 & { readonly operationId: "WT-08"; readonly reason: string })
  | (CommandBaseV1 & { readonly operationId: "WT-09" })
  | (CommandBaseV1 & { readonly operationId: "WT-10"; readonly partialAllowed: boolean })
  | (CommandBaseV1 & {
      readonly operationId: "WT-11";
      readonly transportId: string;
      readonly responseDigest: string;
    })
  | (CommandBaseV1 & { readonly operationId: "WT-12"; readonly responder: Wait.ResponderRefV1 })
  | (CommandBaseV1 & {
      readonly operationId: "WT-13";
      readonly attempt: Wait.ResumeRequestedV1["attempt"];
    })
  | (CommandBaseV1 & { readonly operationId: "WT-14" })
  | (CommandBaseV1 & { readonly operationId: "WT-15" });

export type WaitTransitionResultV1 =
  | {
      readonly status: "committed";
      readonly events: readonly StoredWaitProjectionEventV1[];
      readonly state: WaitProjectionV1;
    }
  | {
      readonly status: "no_commit";
      readonly outcome: "duplicate" | "late_rejected";
      readonly state: WaitProjectionV1;
    }
  | { readonly status: "rejected"; readonly reason: string; readonly state: WaitProjectionV1 };

export interface WaitTransitionFamilyV1 {
  readonly apply: (
    state: WaitProjectionV1,
    command: WaitTransitionCommandV1,
  ) => WaitTransitionResultV1;
}

const DIGEST = /^[0-9a-f]{64}$/;

function sameResponder(left: Wait.ResponderRefV1, right: Wait.ResponderRefV1): boolean {
  return left.actorId === right.actorId && left.endpointId === right.endpointId;
}

function requireOpened(state: WaitProjectionV1): Wait.OpenedV1 {
  if (state.opened === null) throw new Error("wait_not_opened");
  return state.opened;
}

function requireStatus(state: WaitProjectionV1, status: WaitProjectionV1["status"]): void {
  if (state.status !== status) throw new Error(`wait_not_${status}`);
}

function validateBase(command: CommandBaseV1): void {
  if (command.requestId.length === 0) throw new Error("missing_request_id");
  if (!Number.isSafeInteger(command.observedAtDbMs) || command.observedAtDbMs < 0) {
    throw new Error("invalid_database_time");
  }
}

function validateDigest(digest: string): void {
  if (!DIGEST.test(digest)) throw new Error("invalid_response_digest");
}

function responseEvent(
  state: WaitProjectionV1,
  facts: ResponseFactsV1,
  recordedAtDbMs: number,
): Wait.ResponseRecordedV1 {
  const opened = requireOpened(state);
  validateDigest(facts.responseDigest);
  if (facts.transportId.length === 0 || facts.payloadRef.length === 0)
    throw new Error("missing_response_identity");
  if (!opened.expectedResponders.some((expected) => sameResponder(expected, facts.responder))) {
    throw new Error("unexpected_responder");
  }
  if (!opened.allowedActions.includes(facts.action)) throw new Error("action_not_allowed");
  return Wait.ResponseRecordedV1.parse({
    version: "wait.response_recorded.v1",
    waitId: opened.waitId,
    ownerRef: opened.ownerRef,
    responder: facts.responder,
    transportId: facts.transportId,
    responseHash: facts.responseDigest,
    action: facts.action,
    payloadRef: facts.payloadRef,
    recordedAtDbMs,
  });
}

function wrap(
  requestId: string,
  events: readonly WaitProjectionEventV1[],
): StoredWaitProjectionEventV1[] {
  return events.map((event, index) => ({ eventId: `${requestId}:${index + 1}`, event }));
}

function followUpBoundary(state: WaitProjectionV1): number {
  const opened = requireOpened(state);
  if (state.resolution === null) throw new Error("wait_not_resolved");
  return state.resolution.resolvedAtDbMs + opened.followUpWindow;
}

export function createWaitTransitionFamily(): WaitTransitionFamilyV1 {
  const reducer = createWaitReducer();

  function commit(
    state: WaitProjectionV1,
    command: WaitTransitionCommandV1,
    events: readonly WaitProjectionEventV1[],
  ): WaitTransitionResultV1 {
    const stored = wrap(command.requestId, events);
    return { status: "committed", events: stored, state: stored.reduce(reducer.reduce, state) };
  }

  function apply(
    state: WaitProjectionV1,
    command: WaitTransitionCommandV1,
  ): WaitTransitionResultV1 {
    try {
      validateBase(command);
      const opened = command.operationId === "WT-01" ? command.opened : requireOpened(state);
      switch (command.operationId) {
        case "WT-01": {
          requireStatus(state, "absent");
          const event = Wait.OpenedV1.parse(command.opened);
          if (event.waitId.length === 0) throw new Error("missing_wait_id");
          return commit(state, command, [event]);
        }
        case "WT-02":
        case "WT-03": {
          requireStatus(state, "open");
          const response = responseEvent(state, command.response, command.observedAtDbMs);
          const duplicate = state.responsesByTransportId.get(response.transportId);
          if (duplicate !== undefined)
            throw new Error(
              duplicate.event.responseHash === response.responseHash
                ? "use_duplicate_operation"
                : "transport_digest_conflict",
            );
          const nextCount = state.responseEventIds.length + 1;
          const reachesThreshold = nextCount >= opened.quorum.required;
          if (command.operationId === "WT-02") {
            if (reachesThreshold) throw new Error("threshold_requires_atomic_settlement");
            return commit(state, command, [response]);
          }
          if (!reachesThreshold) throw new Error("threshold_not_reached");
          const responseEventId = `${command.requestId}:1`;
          const responseEventIds = [...state.responseEventIds, responseEventId];
          const resolved = Wait.ResolvedV1.parse({
            version: "wait.resolved.v1",
            waitId: opened.waitId,
            ownerRef: opened.ownerRef,
            responseEventIds,
            quorum: opened.quorum,
            partial: false,
            resolvedAtDbMs: command.observedAtDbMs,
          });
          const pending: WaitDispatchPendingV1 = {
            version: "wait-dispatch-pending-v1",
            eventType: "dispatch.pending.v1",
            waitId: opened.waitId,
            dispatchId: `wait:${opened.waitId}:threshold`,
            kind: "threshold_settlement",
            responseEventIds,
            createdAtDbMs: command.observedAtDbMs,
          };
          return commit(state, command, [response, resolved, pending]);
        }
        case "WT-04": {
          validateDigest(command.responseDigest);
          const prior =
            state.responsesByTransportId.get(command.transportId) ??
            state.followUpsByTransportId.get(command.transportId);
          if (prior === undefined) throw new Error("duplicate_not_found");
          if (prior.event.responseHash !== command.responseDigest)
            throw new Error("transport_digest_conflict");
          return { status: "no_commit", outcome: "duplicate", state };
        }
        case "WT-05": {
          const candidates = [...new Set(command.candidateWaitIds)].sort();
          if (candidates.length < 2 || candidates.length !== command.candidateWaitIds.length)
            throw new Error("invalid_ambiguity_candidates");
          validateDigest(command.responseDigest);
          const event = Wait.AmbiguityRecordedV1.parse({
            version: "wait.ambiguity_recorded.v1",
            waitId: opened.waitId,
            ownerRef: opened.ownerRef,
            candidateWaitIds: candidates,
            transportId: command.transportId,
            responseHash: command.responseDigest,
            recordedAtDbMs: command.observedAtDbMs,
          });
          return commit(state, command, [event]);
        }
        case "WT-06": {
          if (!command.authorityRevalidated) throw new Error("authority_not_revalidated");
          const ambiguity = state.ambiguitiesByEventId.get(command.ambiguityEventId);
          if (
            ambiguity === undefined ||
            state.selectedAmbiguityEventIds.has(command.ambiguityEventId) ||
            !ambiguity.candidateWaitIds.includes(command.selectedWaitId)
          )
            throw new Error("invalid_ambiguity_selection");
          const event = Wait.AmbiguitySelectedV1.parse({
            version: "wait.ambiguity_selected.v1",
            waitId: opened.waitId,
            ownerRef: opened.ownerRef,
            ambiguityEventId: command.ambiguityEventId,
            selectedWaitId: command.selectedWaitId,
            selectedAtDbMs: command.observedAtDbMs,
          });
          return commit(state, command, [event]);
        }
        case "WT-07": {
          requireStatus(state, "resolved");
          if (
            command.observedAtDbMs > followUpBoundary(state) ||
            state.followUpsClosedAtDbMs !== null
          )
            throw new Error("follow_up_window_closed");
          validateDigest(command.response.responseDigest);
          if (
            !opened.expectedResponders.some((expected) =>
              sameResponder(expected, command.response.responder),
            )
          )
            throw new Error("unexpected_responder");
          const prior =
            state.followUpsByTransportId.get(command.response.transportId) ??
            state.responsesByTransportId.get(command.response.transportId);
          if (prior !== undefined)
            throw new Error(
              prior.event.responseHash === command.response.responseDigest
                ? "use_duplicate_operation"
                : "transport_digest_conflict",
            );
          const event = Wait.FollowUpRecordedV1.parse({
            version: "wait.follow_up_recorded.v1",
            waitId: opened.waitId,
            ownerRef: opened.ownerRef,
            responder: command.response.responder,
            transportId: command.response.transportId,
            responseHash: command.response.responseDigest,
            payloadRef: command.response.payloadRef,
            recordedAtDbMs: command.observedAtDbMs,
          });
          return commit(state, command, [event]);
        }
        case "WT-08": {
          requireStatus(state, "open");
          return commit(state, command, [
            Wait.CancelledV1.parse({
              version: "wait.cancelled.v1",
              waitId: opened.waitId,
              ownerRef: opened.ownerRef,
              cancelledAtDbMs: command.observedAtDbMs,
              reason: command.reason,
            }),
          ]);
        }
        case "WT-09": {
          requireStatus(state, "open");
          if (command.observedAtDbMs <= opened.deadline) throw new Error("deadline_not_passed");
          return commit(state, command, [
            Wait.ExpiredV1.parse({
              version: "wait.expired.v1",
              waitId: opened.waitId,
              ownerRef: opened.ownerRef,
              expiredAtDbMs: command.observedAtDbMs,
              responseEventIds: state.responseEventIds,
              partial: state.responseEventIds.length > 0,
            }),
          ]);
        }
        case "WT-10": {
          requireStatus(state, "open");
          if (
            !command.partialAllowed ||
            command.observedAtDbMs <= opened.deadline ||
            state.responseEventIds.length === 0 ||
            state.responseEventIds.length >= opened.quorum.required
          )
            throw new Error("partial_resolution_not_allowed");
          const event = Wait.ResolvedV1.parse({
            version: "wait.resolved.v1",
            waitId: opened.waitId,
            ownerRef: opened.ownerRef,
            responseEventIds: state.responseEventIds,
            quorum: opened.quorum,
            partial: true,
            resolvedAtDbMs: command.observedAtDbMs,
          });
          return commit(state, command, [event]);
        }
        case "WT-11": {
          if (state.status === "open") throw new Error("wait_not_terminal");
          validateDigest(command.responseDigest);
          return { status: "no_commit", outcome: "late_rejected", state };
        }
        case "WT-12": {
          requireStatus(state, "open");
          if (
            !opened.expectedResponders.some((expected) =>
              sameResponder(expected, command.responder),
            )
          )
            throw new Error("unexpected_responder");
          const key = `${command.responder.actorId}\0${command.responder.endpointId ?? ""}`;
          const ordinal = (state.remindersByResponder.get(key) ?? 0) + 1;
          const reminder = Wait.ReminderRequestedV1.parse({
            version: "wait.reminder_requested.v1",
            waitId: opened.waitId,
            ownerRef: opened.ownerRef,
            responder: command.responder,
            reminderOrdinal: ordinal,
            requestedAtDbMs: command.observedAtDbMs,
          });
          const effect: WaitEffectIntentV1 = {
            version: "wait-effect-intent-v1",
            eventType: "effect.intent.v1",
            waitId: opened.waitId,
            effectId: `wait:${opened.waitId}:reminder:${key}:${ordinal}`,
            kind: "reminder",
            createdAtDbMs: command.observedAtDbMs,
          };
          return commit(state, command, [reminder, effect]);
        }
        case "WT-13": {
          requireStatus(state, "resolved");
          if (state.resolution === null) throw new Error("wait_not_resolved");
          const resume = Wait.ResumeRequestedV1.parse({
            version: "wait.resume_requested.v1",
            waitId: opened.waitId,
            ownerRef: opened.ownerRef,
            attempt: command.attempt,
            responseEventIds: state.resolution.responseEventIds,
            requestedAtDbMs: command.observedAtDbMs,
          });
          const effect: WaitEffectIntentV1 = {
            version: "wait-effect-intent-v1",
            eventType: "effect.intent.v1",
            waitId: opened.waitId,
            effectId: `wait:${opened.waitId}:resume:${command.attempt.attemptId}`,
            kind: "resume",
            createdAtDbMs: command.observedAtDbMs,
          };
          return commit(state, command, [resume, effect]);
        }
        case "WT-14":
        case "WT-15": {
          requireStatus(state, "resolved");
          if (
            command.observedAtDbMs <= followUpBoundary(state) ||
            state.followUpsClosedAtDbMs !== null
          )
            throw new Error("follow_up_boundary_not_passed");
          const hasFollowUps = state.followUpEventIds.length > 0;
          if (
            (command.operationId === "WT-14" && hasFollowUps) ||
            (command.operationId === "WT-15" && !hasFollowUps)
          )
            throw new Error("follow_up_cardinality_mismatch");
          const event = Wait.FollowUpWindowClosedV1.parse({
            version: "wait.follow_up_window_closed.v1",
            waitId: opened.waitId,
            ownerRef: opened.ownerRef,
            followUpEventIds: state.followUpEventIds,
            closedAtDbMs: command.observedAtDbMs,
          });
          return commit(state, command, [event]);
        }
      }
    } catch (error) {
      return {
        status: "rejected",
        reason: error instanceof Error ? error.message : "invalid_wait_transition",
        state,
      };
    }
  }

  return Object.freeze({ apply });
}
