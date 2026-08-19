import type { Ledger } from "../ledger/index.js";
import type { RoutingDecisionPayload } from "../event/ingress.js";

/**
 * Shared route.decided recorder core (batch ② commit 1). The two ingress
 * arms — the gateway router (external, @openomni/channels) and the brain's
 * internal path (@openomni/openomni) — may not import each other
 * (openomni↛channels = 0/0), so the PURE parts of their once byte-identical
 * `route.decided` recorders are hoisted here: both arms import these and do
 * their OWN durable append (each through its own scoped `LedgerAppend.port()`
 * and its own package-local typed error). Precedent: the #707 slice-1 wait
 * matcher fold hoist to `Wait`.
 */

/** The minimal event scope the route owner-stream key is derived from. */
export type RouteStreamScope = Readonly<{
  surface: string;
  workspace?: string;
  channel?: string;
  id: string;
}>;

/** The ONE `route.decided` fact type string — shared so it cannot drift. */
export const ROUTE_DECIDED_FACT_TYPE = "route.decided";

// Route owner-stream key (#510 review fix F1): normalizer-minted inbound ids
// are only unique WITHIN a channel — telegram normalizer ids are per-chat
// counters and the github normalizer fallback is
// `${eventKey}-${issueNumber}-${sender}-${len}` — so the stream identity
// carries the surface + workspace + channel scope. Without it a colliding id
// from another channel (or an attacker-chosen channel) could preempt or
// replay a foreign decision. Each component is URI-encoded (delimiter
// safety): the protocol schemas allow plain strings, so a ":" inside a
// channel or id could otherwise forge a foreign scope's key (e.g.
// channel "C1" + id "x:5" colliding with channel "C1:x" + id "5").
export function routeStreamId(scope: RouteStreamScope): string {
  const component = (value: string | undefined) => encodeURIComponent(value ?? "");
  return `route:${component(scope.surface)}:${component(scope.workspace)}:${component(scope.channel)}:${component(scope.id)}`;
}

/** The ledger append input for a `route.decided` fact (the fact-payload builder). */
export function routeDecidedFact(streamId: string, decision: RoutingDecisionPayload): Ledger.Input {
  return { streamId, type: ROUTE_DECIDED_FACT_TYPE, data: decision };
}

// Replay equivalence gate (#510 review fix F2): a cas_conflict means this
// inbound was ALREADY decided. The recorded decision and the fresh one must
// agree on every execution-shaping field — stage, outcome, target, sessionId,
// runId, pendingInteractionId — before the redelivery may proceed. Fields
// like traceId/time/reason/factsUsed are delivery-local and deliberately
// excluded.
export function routeDecisionsEquivalent(
  recorded: RoutingDecisionPayload,
  fresh: RoutingDecisionPayload,
): boolean {
  return (
    recorded.stage === fresh.stage &&
    recorded.outcome === fresh.outcome &&
    recorded.target === fresh.target &&
    recorded.sessionId === fresh.sessionId &&
    recorded.runId === fresh.runId &&
    recorded.pendingInteractionId === fresh.pendingInteractionId
  );
}
