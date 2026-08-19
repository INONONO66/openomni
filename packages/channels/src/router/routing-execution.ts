import { Wait, type Gateway, type Ingress } from "@openomni/protocol";
import type { TraceContext } from "@openomni/protocol";
import { WaitService, targetsOfWait } from "./wait/index.js";
import { IngressRoutingError, type KernelRouteResolution } from "./routing-resolution.js";

type RoutedDecision = Extract<Ingress.RoutingDecisionPayload, { readonly outcome: "route" }>;

type BlacklistDropDecision = Extract<
  Ingress.RoutingDecisionPayload,
  { readonly stage: "blacklist"; readonly outcome: "drop" }
>;
type AcceptedDecision = RoutedDecision | BlacklistDropDecision;

function factValue(decision: Ingress.RoutingDecisionPayload, prefix: string): string | undefined {
  const fact = decision.factsUsed.find((candidate) => candidate.startsWith(prefix));
  return fact?.slice(prefix.length);
}

function terminalMessage(decision: Ingress.RoutingDecisionPayload): string {
  if (decision.stage === "blacklist") {
    return factValue(decision, "blacklist.reason:") ?? decision.reason;
  }
  if (decision.stage === "channel_ceiling") {
    if (decision.factsUsed.includes("channel:missing")) return "channel_grant.missing";
    const kind = factValue(decision, "channel.kind:");
    const treatment = factValue(decision, "channel.treatment:");
    if (kind !== undefined && treatment !== undefined) {
      return `channel_grant.${kind}.${treatment}`;
    }
  }
  if (decision.stage === "actor_identity") {
    return "actor is not authorized to create top-level inbound work";
  }
  return decision.reason;
}

export function requireRoutedDecision(decision: Ingress.RoutingDecisionPayload): AcceptedDecision {
  if (decision.outcome === "route") return decision;
  if (decision.stage === "blacklist" && decision.outcome === "drop") return decision;
  if (decision.outcome === "ambiguous") {
    throw new IngressRoutingError("route_ambiguous", decision.reason, decision);
  }
  throw new IngressRoutingError("route_blocked", terminalMessage(decision), decision);
}

export function pinRouteSession<Event extends Gateway.DeliveredEvent>(
  event: Event,
  decision: AcceptedDecision,
): Event {
  if (decision.sessionId === undefined) return event;
  return {
    ...event,
    activation: {
      ...event.activation,
      durableSessionId: decision.sessionId,
    },
  };
}

export function pinSelectedTarget<Event extends Gateway.DeliveredEvent>(
  event: Event,
  target: Ingress.Target,
): Event {
  return { ...event, target };
}

function projectWaitOwnerEvent<Event extends Gateway.DeliveredEvent>(
  event: Event,
  ownerSessionId: string,
): Omit<Event, "target"> & { readonly target?: never } {
  const { target: _target, ...withoutTarget } = event;
  const { target: _metaTarget, ...meta } = event.meta ?? {};
  const { runId: _runId, ...activation } = event.activation ?? {};
  return {
    ...withoutTarget,
    meta,
    activation: { ...activation, durableSessionId: ownerSessionId },
  } as Omit<Event, "target"> & { readonly target?: never };
}

function projectPendingAskEvent<Event extends Gateway.DeliveredEvent>(
  event: Event,
  resolution: Extract<KernelRouteResolution["waitExecution"], { kind: "pending_ask" }>,
): Omit<Event, "target"> & { readonly target?: never } {
  const { target: _target, ...withoutTarget } = event;
  const { target: _metaTarget, ...meta } = event.meta ?? {};
  const { runId: _runId, ...activation } = event.activation ?? {};
  const record = resolution.record;
  return {
    ...withoutTarget,
    meta: {
      ...meta,
      pendingAsk: {
        id: record.id,
        originSessionId: record.originSessionId,
        ...(record.originRunId === undefined ? {} : { originRunId: record.originRunId }),
        originActorKind: record.originActorKind,
        targetKind: record.targetKind,
        status: record.status,
        ambiguous: false,
      },
    },
    activation: {
      ...activation,
      durableSessionId: record.originSessionId,
      ...(record.originRunId === undefined ? {} : { runId: record.originRunId }),
    },
  } as Omit<Event, "target"> & { readonly target?: never };
}

export type WaitRouteExecution<Event extends Gateway.DeliveredEvent = Gateway.DeliveredEvent> =
  | Readonly<{
      kind: "continue";
      event: Event | (Omit<Event, "target"> & { readonly target?: never });
      /**
       * "required": routed pre-run authority must still run before delivery.
       * "wait_precedence": a wait/pending_ask resumption — correlation is the
       * admission, the pre-run is skipped (frozen behavior).
       * "pending_interaction": a matched frozen pending-interaction row —
       * dispatch work placement is brain judgment (kernel-contract §8.5), so
       * the router delivers and the brain's Deliver consumer executes the
       * dispatch; the pre-run is skipped exactly as it was before the flip.
       */
      authority: "required" | "wait_precedence" | "pending_interaction";
    }>
  | Readonly<{ kind: "handled"; result: Ingress.IngressResult }>;

export async function executeWaitRoute<Event extends Gateway.DeliveredEvent>(
  trace: TraceContext.Type,
  resolution: KernelRouteResolution<Event>,
  decision: AcceptedDecision,
): Promise<WaitRouteExecution<Event>> {
  if (decision.stage === "blacklist" && decision.outcome === "drop") {
    return {
      kind: "handled",
      result: {
        kind: "dropped",
        mode: resolution.event.mode,
        target: resolution.selectedTarget,
        reason: decision.reason,
      },
    };
  }
  if (decision.outcome !== "route") {
    throw new TypeError("accepted terminal routing decision was not handled");
  }
  const wait = resolution.waitExecution;
  switch (wait.kind) {
    case "none":
      return { kind: "continue", event: resolution.event, authority: "required" };
    case "wait": {
      if (decision.stage !== "wait_correlation") {
        throw new IngressRoutingError(
          "dispatch_route_invalid",
          "wait route is incomplete",
          decision,
        );
      }
      // The matcher only returns candidates; the protocol fold decides
      // (duplicate / late / unknown / ambiguous / attach / resolve) and the
      // store persists the outcome before the owner session sees the reply.
      const at = Date.now();
      const outcome = WaitService.attachReply(
        wait.record.id,
        {
          replyKey: resolution.event.id,
          responderCandidates: Wait.responderCandidates(
            targetsOfWait(wait.record),
            Wait.ingressEvidence(resolution.event, wait.correlation),
          ),
          messageId: resolution.event.id,
          at,
        },
        trace.traceId,
      );
      if (outcome.kind === "rejected") {
        if (outcome.code === "deadline_passed") {
          // Lazy expiry: this late reply is the first observer of the passed
          // deadline — fold the wait to expired (recording partial progress)
          // before rejecting, so the ledger never keeps a dead open wait that
          // the boot sweep alone would have to find. A concurrent ingest may
          // have already folded the wait terminal (revision CAS conflict);
          // the expiry is an optimization, so it must never replace the typed
          // rejection below.
          try {
            WaitService.expire(wait.record.id, trace.traceId, at);
          } catch {
            // Already folded by a concurrent transition — the typed rejection
            // below is still the correct outcome for this reply.
          }
        }
        throw new IngressRoutingError(
          "wait_reply_rejected",
          `wait reply rejected: ${outcome.code}`,
          decision,
        );
      }
      // "already_resolved" (channel redelivery of the resolving reply) falls
      // through on purpose: the owner delivery repeats idempotently with the
      // recorded resolution — no state change, no revision bump.
      // resolve-route routed this decision, so the owner is a session
      // (workItem owners fail closed at the wait_correlation stage).
      return {
        kind: "continue",
        event: projectWaitOwnerEvent(resolution.event, wait.record.ownerRef.id),
        authority: "wait_precedence",
      };
    }
    case "pending_interaction":
      if (decision.stage !== "wait_correlation") {
        return { kind: "continue", event: resolution.event, authority: "required" };
      }
      // Frozen-row match: the record/correlation checks and the dispatch
      // submit stay brain-side (work placement, §8.5) — the router only
      // asserts the routed stage and hands the event across the seam with
      // the recorded decision (which carries pendingInteractionId).
      return { kind: "continue", event: resolution.event, authority: "pending_interaction" };
    case "pending_ask":
      // resolve-route copies the resident target and origin session/run into the
      // decision from this same record; only the stage gate is checked here.
      if (decision.stage !== "wait_correlation") {
        throw new IngressRoutingError(
          "dispatch_route_invalid",
          "pending ask route is incomplete",
          decision,
        );
      }
      return {
        kind: "continue",
        event: projectPendingAskEvent(resolution.event, wait),
        authority: "wait_precedence",
      };
    case "ambiguous":
      throw new IngressRoutingError(
        "dispatch_route_invalid",
        "ambiguous wait cannot accompany a routed decision",
        decision,
      );
    default: {
      const unreachable: never = wait;
      throw new TypeError(`Unreachable wait execution: ${String(unreachable)}`);
    }
  }
}
