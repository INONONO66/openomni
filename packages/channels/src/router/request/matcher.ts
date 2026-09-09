import type { Ingress, SessionTransition } from "@openomni/protocol";
import { ActorRegistry } from "@openomni/ledger";
type Correlation = SessionTransition.Correlation;

/** Physical responder evidence only; kernel request transitions own admission and persistence. */

type ResponderTarget = Readonly<{
  /** Responder id credited to the fold when this target matches. */
  responderId: string;
  /** Pinned actor identity; when present the sender must resolve to it. */
  targetActorId?: string;
  /** Expected endpoint; when present the sender must prove control of it. */
  endpointId?: string;
  /** Bearer credential: a matching tokenHash stands in for identity when no actor is pinned. */
  tokenHash?: string;
}>;

type SenderEvidence = Readonly<{
  /** Bearer credential presented via correlation. */
  tokenHash?: string;
  /** Endpoint the sender claims via correlation (consistency-checked, not proof). */
  claimedEndpointId?: string;
  /** Resolved sender identity, when the phase could establish one. */
  actorId?: string;
  /** Phase extension: does the presented evidence prove control of the expected endpoint? */
  provesEndpoint: (expectedEndpointId: string) => boolean;
}>;

/**
 * Core match rule, shared by both phases:
 * 1. bearer tokenHash matches an unpinned target;
 * 2. a claimed endpoint must not contradict the expected one;
 * 3. a pinned targetActorId must equal the resolved sender identity;
 * 4. an expected endpoint must be proven by phase evidence; without an
 *    expected endpoint the resolved identity match alone carries.
 */
function matchesTarget(target: ResponderTarget, evidence: SenderEvidence): boolean {
  const bearerMatch =
    target.targetActorId === undefined &&
    target.tokenHash !== undefined &&
    evidence.tokenHash === target.tokenHash;
  if (bearerMatch) return true;
  if (
    target.endpointId !== undefined &&
    evidence.claimedEndpointId !== undefined &&
    evidence.claimedEndpointId !== target.endpointId
  ) {
    return false;
  }
  if (target.targetActorId !== undefined && evidence.actorId !== target.targetActorId) {
    return false;
  }
  if (target.endpointId !== undefined) return evidence.provesEndpoint(target.endpointId);
  return target.targetActorId !== undefined;
}

export function responderCandidates(
  targets: readonly ResponderTarget[],
  evidence: SenderEvidence,
): string[] {
  return [
    ...new Set(
      targets.filter((target) => matchesTarget(target, evidence)).map((t) => t.responderId),
    ),
  ];
}

/** Ingress evidence extension: resolved-actor endpoint proof with the direct-mode userId fallback. */
export function ingressEvidence(
  // Structural pick (#707 stage 2): the gateway router matches evidence on
  // the routed event BEFORE the brain-owned AgentDef exists, so the full
  // DirectEvent (which requires `agent`) is deliberately not demanded here.
  event: Pick<Ingress.InboundEvent, "mode" | "surface" | "userId" | "meta">,
  correlation: Correlation,
): SenderEvidence {
  const actor = event.meta?.actor;
  const actorId = typeof actor?.actorId === "string" ? actor.actorId : undefined;
  return {
    ...(correlation.tokenHash === undefined ? {} : { tokenHash: correlation.tokenHash }),
    claimedEndpointId: correlation.endpointId,
    ...(actorId === undefined ? {} : { actorId }),
    provesEndpoint: (expected) => {
      if (actorId !== undefined) {
        const endpoint = actor?.endpoint;
        if (endpoint === undefined) return actor?.endpointId === expected;
        return (
          endpoint.id === expected ||
          endpoint.externalId === expected ||
          `${endpoint.channel}:${endpoint.externalId}` === expected
        );
      }
      if (event.mode !== "direct" || typeof event.userId !== "string") return false;
      // The prefixed form is bound to the event surface: a same-named user id
      // on a different surface must not prove this endpoint.
      return event.userId === expected || expected === `${event.surface}:${event.userId}`;
    },
  };
}

/**
 * Matcher targets for a durable request row: every expected responder is an
 * actor pin. The request's correlation.endpointId is the DELIVERY endpoint, so
 * it pins ONLY the responder who is the delivery target. `deliveryActorId`
 * is the registry-resolved actor registered at that endpoint (registry-anchored,
 * not sender-claimed — the ActorRegistry lookup happens here). Every other expected responder replies from their OWN
 * endpoint, and their identity proof is the resolved-actor evidence alone.
 * Because every target carries an actor pin, request rows never accept
 * bearer-only replies. A delivery endpoint that no longer resolves
 * (`deliveryActorId === undefined` while the endpoint pin is present) fails
 * closed: no candidates, rather than a weaker unpinned target set.
 */
export function targetsOfRequest(record: SessionTransition.Request): ResponderTarget[] {
  const deliveryEndpointId = record.correlation.endpointId;
  const deliveryActorId =
    deliveryEndpointId === undefined
      ? undefined
      : ActorRegistry.getEndpoint(deliveryEndpointId)?.actorId;
  if (deliveryEndpointId !== undefined && deliveryActorId === undefined) {
    return [];
  }
  return record.expectedResponders.map((responderId) => ({
    responderId,
    targetActorId: responderId,
    ...(deliveryEndpointId !== undefined && responderId === deliveryActorId
      ? { endpointId: deliveryEndpointId }
      : {}),
  }));
}
