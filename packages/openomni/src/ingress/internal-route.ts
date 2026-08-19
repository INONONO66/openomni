import {
  Ingress,
  Wait,
  extractSurfaceKey,
  resolveTarget,
  targetKey,
  type Actor,
} from "@openomni/protocol";
import { BlacklistStore, LedgerAppend, SurfaceKey } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";

/**
 * Internal-mode routing (#707 stage 2): internal events (cron fire, dispatch
 * resident.ask) never cross the perimeter — the brain keeps the internal arm
 * of the old resolveRoute fold and its own route.decided recording path.
 * Same fact strings, same `route:<scope>` stream, same append discipline;
 * only the home moved. External arms live exclusively in the gateway router
 * (@openomni/channels).
 *
 * Wait correlation is retired on this path (recorded residue): no production
 * internal event carries a correlation envelope, and every internal event id
 * is a freshly minted UUID that cannot equal a frozen legacy
 * externalMessageId — the decision's `wait:none` fact is a structural truth
 * here, not a lookup result.
 */

export type IngressRoutingErrorCode =
  | "route_blocked"
  | "route_ambiguous"
  | "route_record_failed"
  /** Redelivered inbound whose fresh decision diverges from the recorded route.decided fact — fail closed, no action, no second fact (#510 review fix F2). */
  | "route_replay_divergent"
  | "dispatch_runtime_missing"
  | "dispatch_route_invalid"
  | "dispatch_failed"
  | "dispatch_output_unsupported"
  | "wait_reply_rejected";

export class IngressRoutingError extends Error {
  readonly code: IngressRoutingErrorCode;
  readonly decision: Ingress.RoutingDecisionPayload;

  constructor(
    code: IngressRoutingErrorCode,
    message: string,
    decision: Ingress.RoutingDecisionPayload,
  ) {
    super(message);
    this.name = "IngressRoutingError";
    this.code = code;
    this.decision = decision;
  }
}

/**
 * #498 C3: correlation claims reuse THE one Wait.Correlation shape; the
 * endpoint+channel scope pins are required at every producing seam. Internal
 * events carry no correlation in production — this parse exists for fidelity
 * of the blacklist candidate set with the pre-flip pipeline.
 */
type ScopedCorrelation = Wait.Correlation & Readonly<{ endpointId: string; channelId: string }>;
const ScopedCorrelationClaim = Wait.Correlation.refine(
  (value): value is ScopedCorrelation =>
    value.endpointId !== undefined && value.channelId !== undefined,
  { message: "correlation claims require endpointId and channelId" },
);

function parseCorrelation(event: Ingress.InternalEvent): ScopedCorrelation | undefined {
  const value = event.meta?.correlation;
  return value === undefined ? undefined : ScopedCorrelationClaim.parse(value);
}

type InternalBlacklist = Readonly<{
  id: string;
  kind: Actor.BlacklistKind;
  reason?: string;
}>;

export type InternalRouteInbound = {
  readonly traceId: string;
  readonly time: number;
  readonly id: string;
  readonly surface: string;
  readonly mode: "internal";
  readonly target: string;
};

export type InternalRouteState = {
  readonly blacklist?: InternalBlacklist;
  readonly surfaceSessionId?: string;
  readonly systemActorId?: string;
};

/**
 * The internal-mode arm of the routing fold — decision strings, stages, and
 * factsUsed byte-frozen from the pre-flip resolveRoute.
 */
export function resolveInternalRoute(
  inbound: InternalRouteInbound,
  state: InternalRouteState,
): Ingress.RoutingDecisionPayload {
  const common = {
    traceId: inbound.traceId,
    time: inbound.time,
    inboundId: inbound.id,
    surface: inbound.surface,
    mode: inbound.mode,
  };

  if (state.blacklist !== undefined) {
    return {
      ...common,
      stage: "blacklist",
      outcome: "drop",
      reason: "Inbound principal matched the blacklist",
      factsUsed: [
        `blacklist:${state.blacklist.id}`,
        `blacklist.kind:${state.blacklist.kind}`,
        ...(state.blacklist.reason === undefined
          ? []
          : [`blacklist.reason:${state.blacklist.reason}`]),
      ],
    };
  }

  const waitFacts = ["wait:none"];

  if (state.systemActorId === undefined) {
    return {
      ...common,
      stage: "actor_identity",
      outcome: "block",
      reason: "Internal inbound message has no system actor",
      factsUsed: [...waitFacts, "actor.system:missing"],
    };
  }
  return {
    ...common,
    stage: "surface_default",
    outcome: "route",
    target: inbound.target,
    ...(state.surfaceSessionId === undefined ? {} : { sessionId: state.surfaceSessionId }),
    actorId: state.systemActorId,
    reason: "Internal system actor routed to the surface session",
    factsUsed: [
      ...waitFacts,
      `actor.system:${state.systemActorId}`,
      state.surfaceSessionId === undefined
        ? "surface.default:new"
        : `surface.default:${state.surfaceSessionId}`,
      `target:${inbound.target}`,
    ],
  };
}

function blacklistState(
  event: Ingress.InternalEvent,
  correlation: ScopedCorrelation | undefined,
): InternalBlacklist | undefined {
  const actor = event.meta?.actor;
  const entry = BlacklistStore.match({
    actorId: typeof actor?.actorId === "string" ? actor.actorId : undefined,
    endpointId:
      (typeof actor?.endpointId === "string" ? actor.endpointId : undefined) ??
      correlation?.endpointId,
    channel: correlation?.channelId ?? event.surface,
    candidates: [
      event.surface,
      ...(event.channel === undefined ? [] : [event.channel]),
      ...(correlation === undefined ? [] : [correlation.channelId]),
      `${event.surface}:${event.workspace ?? ""}:${event.channel ?? ""}`,
    ],
  });
  if (entry === undefined) return undefined;
  return {
    id: entry.id,
    kind: entry.kind,
    reason: entry.reason ?? `blacklist.${entry.kind}.${entry.value}`,
  };
}

// The route owner-stream key (#510 F1) and the replay equivalence gate
// (#510 F2) are the PURE parts of this recorder, hoisted to protocol
// (`Ingress.routeStreamId` / `Ingress.routeDecisionsEquivalent` /
// `Ingress.routeDecidedFact`) — byte-identical to the gateway router's
// external arm so internal and external decisions share ONE stream family
// and cannot drift. Only the append below stays per-side; it now records
// through the SAME scoped `LedgerAppend.port()` surface the router uses
// (ledger-audit finding: internal-route must use the port, not raw
// `Storage.get().ledger`) and throws the brain-local typed error.

// #510 C3 ruling 1 — the routing decision is a decision-class fact on the
// single-fact owner stream (expectedHead 0), awaited durably BEFORE anything
// acts on the decision. No record, no action; equivalence-gated replay
// carve-out as on the external path.
function recordRouteDecided(
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
    recorded = Ingress.Events.RoutingDecision.schema.parse(fact.data);
  } catch (error) {
    throw new IngressRoutingError(
      "route_record_failed",
      `recorded routing decision read failed: ${error instanceof Error ? error.message : String(error)}`,
      decision,
    );
  }
  if (!Ingress.routeDecisionsEquivalent(recorded, decision)) {
    throw new IngressRoutingError(
      "route_replay_divergent",
      `redelivered inbound diverges from its recorded routing decision: recorded ${recorded.stage}/${recorded.outcome}, fresh ${decision.stage}/${decision.outcome}`,
      decision,
    );
  }
  return decision;
}

export type InternalRouteResolution = Readonly<{
  decision: Ingress.RoutingDecisionPayload;
  selectedTarget: Ingress.Target;
}>;

export function resolveAndRecordInternalRoute(
  event: Ingress.InternalEvent,
  traceId: string,
): InternalRouteResolution {
  const correlation = parseCorrelation(event);
  const selectedTarget = resolveTarget(event);
  const surfaceSessionId =
    event.activation?.durableSessionId ?? SurfaceKey.lookup(extractSurfaceKey(event));
  const blacklist = blacklistState(event, correlation);
  const decision = Ingress.Events.RoutingDecision.schema.parse(
    resolveInternalRoute(
      {
        traceId,
        time: Date.now(),
        id: event.id,
        surface: event.surface,
        mode: event.mode,
        target: targetKey(selectedTarget),
      },
      {
        ...(blacklist === undefined ? {} : { blacklist }),
        ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
        systemActorId: `system:${event.surface}`,
      },
    ),
  );
  const effective = recordRouteDecided(Ingress.routeStreamId(event), decision);
  // Observe-only projection — strictly after the append; lossy by contract.
  Bus.publish(Ingress.Events.RoutingDecision, effective);
  return { decision: effective, selectedTarget };
}

type RoutedDecision = Extract<Ingress.RoutingDecisionPayload, { readonly outcome: "route" }>;
type BlacklistDropDecision = Extract<
  Ingress.RoutingDecisionPayload,
  { readonly stage: "blacklist"; readonly outcome: "drop" }
>;
export type AcceptedInternalDecision = RoutedDecision | BlacklistDropDecision;

export function requireRoutedInternalDecision(
  decision: Ingress.RoutingDecisionPayload,
): AcceptedInternalDecision {
  if (decision.outcome === "route") return decision;
  if (decision.stage === "blacklist" && decision.outcome === "drop") return decision;
  if (decision.outcome === "ambiguous") {
    throw new IngressRoutingError("route_ambiguous", decision.reason, decision);
  }
  // Blacklist decisions are always drops (returned above); the only internal
  // block stage is actor_identity, whose terminal message is frozen.
  const message =
    decision.stage === "actor_identity"
      ? "actor is not authorized to create top-level inbound work"
      : decision.reason;
  throw new IngressRoutingError("route_blocked", message, decision);
}
