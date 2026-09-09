import { Ingress, type SessionTransition, type Gateway, type Ledger } from "@openomni/protocol";
import { LedgerAppend } from "@openomni/ledger";
import { targetsOfRequest, responderCandidates, ingressEvidence } from "./request/matcher.js";
import type { GatewayRouterPorts } from "./message-ports.js";
import type { resolveAndRecordRoute } from "./routing-resolution.js";
import { IngressRoutingError } from "./routing-error";

// route_correction producer (batch ② commit 4): a routed request-correlated
// delivery whose reply is rejected fail-closed by kernel request admission leaves a
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
  // resolveAndRecordRoute has just appended through this same synchronous
  // adapter; no user code or await can replace it before correction.
  const ledger = LedgerAppend.port() as LedgerAppend.Port;
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

function factValue(decision: Ingress.RoutingDecisionPayload, prefix: string): string | undefined {
  const fact = decision.factsUsed.find((candidate) => candidate.startsWith(prefix));
  return fact?.slice(prefix.length);
}

function terminalMessage(decision: Ingress.RoutingDecisionPayload): string {
  if (decision.stage === "channel_ceiling") {
    if (decision.factsUsed.includes("channel:missing")) return "channel_grant.missing";
    const kind = factValue(decision, "channel.kind:");
    const treatment = factValue(decision, "channel.treatment:");
    if (kind !== undefined && treatment !== undefined) return `channel_grant.${kind}.${treatment}`;
  }
  if (decision.stage === "actor_identity") {
    return "actor is not authorized to create top-level inbound work";
  }
  return decision.reason;
}

export function requireRoutedDecision(decision: Ingress.RoutingDecisionPayload): RoutedDecision {
  if (decision.outcome === "route") return decision;
  if (decision.outcome === "ambiguous") {
    throw new IngressRoutingError("route_ambiguous", decision.reason, decision);
  }
  throw new IngressRoutingError("route_blocked", terminalMessage(decision), decision);
}

export async function executeRequestRoute<Event extends Gateway.DeliveredEvent>(
  resolution: ReturnType<typeof resolveAndRecordRoute<Event>>,
  decision: RoutedDecision,
  requests: GatewayRouterPorts["requests"],
  content: string,
  at: number,
): Promise<void> {
  const matched = resolution.requestExecution;
  if (matched.kind === "none") return;
  const record = matched.record;
  const actor = resolution.event.meta?.actor;
  const candidates = responderCandidates(
    targetsOfRequest(record),
    ingressEvidence(resolution.event, matched.correlation),
  );
  let outcome: SessionTransition.Resolution = "rejected";
  if (
    record.mode === "reply" &&
    candidates.length === 1 &&
    actor?.actorId !== undefined &&
    actor.actorId === candidates[0] &&
    matched.requestedAction !== "invalid"
  ) {
    outcome = await requests.answer({
      inputId: resolution.event.id,
      requestId: record.requestId,
      sessionId: record.sessionId,
      receivedAt:
        record.replies.find((reply) => reply.replyId === resolution.event.id)?.receivedAt ?? at,
      principal: {
        kind: actor.trustTier === "owner" ? "owner" : "actor",
        principalId: actor.actorId,
        evidenceId: resolution.event.id,
      },
      bindingDigest: record.bindingDigest,
      inputHash: record.inputHash,
      effectHash: record.effectHash,
      generation: record.generation,
      toolsHash: record.toolsHash,
      domainRevisions: record.domainRevisions,
      decision: "reply",
      allowedAction: matched.requestedAction,
      content,
    });
  }
  if (outcome === "attached" || outcome === "resolved") return;
  const reason = `request reply rejected: ${outcome}`;
  recordRouteNotDelivered(resolution.event, decision, reason);
  throw new IngressRoutingError("request_reply_rejected", reason, decision);
}
