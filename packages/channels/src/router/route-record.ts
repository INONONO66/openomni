import { Ingress } from "@openomni/protocol";
import { LedgerAppend } from "@openomni/ledger";
import { replyGrantEndpointFromFacts } from "./messaging/reply-grant";
import { IngressRoutingError } from "./routing-error";

/** Append before projection; a competing fact must preserve both routing and reply authority. */
export function recordRouteDecided(
  streamId: string,
  decision: Ingress.RoutingDecisionPayload,
): Ingress.RoutingDecisionPayload {
  const ledger = LedgerAppend.port();
  if (!ledger) {
    throw new IngressRoutingError(
      "route_record_failed",
      "Storage adapter does not implement ledger append — routing decisions fail closed",
      decision,
    );
  }
  let appended: ReturnType<typeof ledger.append>;
  try {
    appended = ledger.append(Ingress.routeDecidedFact(streamId, decision), 0);
  } catch (error) {
    throw new IngressRoutingError(
      "route_record_failed",
      `routing decision append failed: ${error instanceof Error ? error.message : String(error)}`,
      decision,
    );
  }
  if (appended.kind === "appended") return decision;
  let recorded: Ingress.RoutingDecisionPayload;
  try {
    const fact = ledger.headFact(streamId);
    if (fact === undefined || fact.type !== Ingress.ROUTE_DECIDED_FACT_TYPE) {
      throw new Error(`stream ${streamId} conflicted without a recorded route.decided fact`);
    }
    // Pre-0025 facts are upcast by the protocol's bounded persisted-wire reader.
    const upcast = Ingress.recordedRoutingDecision(fact.data);
    if (upcast === undefined) {
      throw new Error(`stream ${streamId} recorded route.decided fact failed to parse`);
    }
    recorded = upcast;
  } catch (error) {
    throw new IngressRoutingError(
      "route_record_failed",
      `recorded routing decision read failed: ${error instanceof Error ? error.message : String(error)}`,
      decision,
    );
  }
  const recordedEndpoint = replyGrantEndpointFromFacts(recorded.factsUsed);
  const freshEndpoint = replyGrantEndpointFromFacts(decision.factsUsed);
  const endpointEquivalent =
    recordedEndpoint?.channel === freshEndpoint?.channel &&
    recordedEndpoint?.externalId === freshEndpoint?.externalId;
  if (!Ingress.routeDecisionsEquivalent(recorded, decision) || !endpointEquivalent) {
    // Never expose either side's authority fields in the rejection.
    throw new IngressRoutingError(
      "route_replay_divergent",
      "redelivered inbound diverges from its recorded routing decision on an execution- or authority-shaping field",
      decision,
    );
  }
  return decision;
}
