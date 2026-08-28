import { Ingress, Wait, type Gateway, type Ledger } from "@openomni/protocol";
import type { TraceContext } from "@openomni/protocol";
import { LedgerAppend } from "@openomni/ledger";
import { WaitService, targetsOfWait } from "./wait/index.js";
import { IngressRoutingError, type KernelRouteResolution } from "./routing-resolution.js";

// route_correction producer (batch ② commit 4): a routed wait-correlated
// delivery whose reply is rejected fail-closed at the wait fold leaves a
// route.decided fact claiming outcome:route for a delivery that never
// happened. This appends a correcting route.not_delivered fact on the
// separate route_correction:<scope>:<id> stream so the ledger reflects
// reality — the route stream's single-fact route.decided replay gate is left
// untouched. This module is the class's sole producer (ledger-producer
// manifest). Idempotent under channel redelivery: the correction is a
// single-fact stream, so a redelivered rejection sees cas_conflict and the
// recorded correction stands.
function recordRouteNotDelivered(
  event: Gateway.DeliveredEvent,
  decision: Ingress.RoutingDecisionPayload,
  reason: string,
): void {
  const ledger = LedgerAppend.port();
  if (!ledger) {
    throw new IngressRoutingError(
      "route_record_failed",
      "Storage adapter does not implement ledger append — the route not-delivered correction fails closed",
      decision,
    );
  }
  const streamId = Ingress.routeCorrectionStreamId(event);
  const correction: Ledger.RouteNotDelivered = { inboundId: event.id, reason };
  let appended: ReturnType<typeof ledger.append>;
  try {
    appended = ledger.append(Ingress.routeNotDeliveredFact(streamId, correction), 0);
  } catch (error) {
    throw new IngressRoutingError(
      "route_record_failed",
      `route not-delivered correction append failed: ${error instanceof Error ? error.message : String(error)}`,
      decision,
    );
  }
  if (appended.kind === "appended") return;
  // cas_conflict — the correction already sits at seq 1 (idempotent redelivery
  // of the same rejected reply). Confirm the recorded fact and return.
  const fact = ledger.headFact(streamId);
  if (fact !== undefined && fact.type === Ingress.ROUTE_NOT_DELIVERED_FACT_TYPE) return;
  throw new IngressRoutingError(
    "route_record_failed",
    `route not-delivered correction conflicted without a recorded correction fact on ${streamId}`,
    decision,
  );
}

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

export type WaitRouteExecution<Event extends Gateway.DeliveredEvent = Gateway.DeliveredEvent> =
  | Readonly<{
      kind: "continue";
      event: Event | (Omit<Event, "target"> & { readonly target?: never });
      /**
       * "required": routed pre-run authority must still run before delivery.
       * "wait_precedence": a wait resumption — correlation is the admission,
       * the pre-run is skipped (frozen behavior).
       */
      authority: "required" | "wait_precedence";
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
        // Fix the ledger lie (batch ② commit 4): route.decided already recorded
        // outcome:route for this correlated reply, but the wait fold rejects it
        // fail-closed (a non-responder must not resume a wait — gateway-design
        // §2a-1) and the message is dropped. Append the correcting
        // route.not_delivered fact BEFORE returning the rejection so the ledger
        // never claims a delivery that never happened.
        const reason = `wait reply rejected: ${outcome.code}`;
        recordRouteNotDelivered(resolution.event, decision, reason);
        throw new IngressRoutingError("wait_reply_rejected", reason, decision);
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
