import { z } from "zod";
import {
  type Gateway,
  Ingress,
  NamedError,
  SessionTransition,
  resolveTarget,
  targetKey,
  type BusEvent,
} from "@openomni/protocol";
import { LedgerAppend, SurfaceKey } from "@openomni/ledger";
import { applyChannelGrantTreatment } from "./authority.js";
import { matchBlacklist } from "./blacklist.js";
import { resolveChannelGrant } from "./channel-grant.js";
import { replyGrantEndpointFacts, replyGrantEndpointFromFacts } from "./messaging/reply-grant.js";
import { resolveRoute, type RouteState } from "./resolve-route.js";
import { findRequestCandidates, type RequestResolution } from "./request/correlation.js";
import type { GatewayRouterPorts } from "./message-ports.js";

const ingressRoutingErrorCodes = [
  "route_blocked",
  "route_ambiguous",
  "route_record_failed",
  /** Redelivered inbound whose fresh decision diverges from the recorded route.decided fact — fail closed, no action, no second fact (#510 review fix F2). */
  "route_replay_divergent",
  "request_reply_rejected",
] as const;
type IngressRoutingErrorCode = (typeof ingressRoutingErrorCodes)[number];
const IngressRoutingErrorCode = z.enum(ingressRoutingErrorCodes);

/** Request matching requires both endpoint and channel scope pins. */
const ScopedCorrelationClaim = SessionTransition.Correlation.required({
  endpointId: true,
  channelId: true,
});
type ScopedCorrelation = z.infer<typeof ScopedCorrelationClaim>;
const RequestActionPayload = z.object({ action: z.json().catch(null).optional() });

const IngressRoutingErrorBase = NamedError.create(
  "IngressRoutingError",
  NamedError.Unknown.Schema.shape.data.extend({
    code: IngressRoutingErrorCode,
    decision: Ingress.Events.RoutingDecision.schema,
  }),
);

export class IngressRoutingError extends IngressRoutingErrorBase {
  constructor(
    code: IngressRoutingErrorCode,
    message: string,
    decision: Ingress.RoutingDecisionPayload,
  ) {
    super({ code, message, decision });
  }

  get code(): IngressRoutingErrorCode {
    return this.data.code;
  }

  get decision(): Ingress.RoutingDecisionPayload {
    return this.data.decision;
  }
}

type KernelRequestExecution =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "request";
      // Required: a request match can only come from the request tier, which
      // refuses without a correlation envelope — optionality here would
      // weaken the sender-match evidence below its real invariant.
      correlation: ScopedCorrelation;
      requestedAction: SessionTransition.AllowedAction | "invalid";
      record: SessionTransition.Request;
    }>;

export type KernelRouteResolution<Event extends Gateway.DeliveredEvent = Gateway.DeliveredEvent> =
  Readonly<{
    decision: Ingress.RoutingDecisionPayload;
    event: Event;
    requestExecution: KernelRequestExecution;
  }>;

function parseCorrelation(event: Gateway.DeliveredEvent): ScopedCorrelation | undefined {
  const value = event.meta?.correlation;
  return value === undefined ? undefined : ScopedCorrelationClaim.parse(value);
}

function routeRequestState(resolution: RequestResolution): RouteState["request"] {
  switch (resolution.kind) {
    case "none":
      return { kind: "none" };
    case "ambiguous":
      return {
        kind: "ambiguous",
        candidateInteractionIds: resolution.candidates.map((candidate) => candidate.key),
      };
    case "match": {
      const record = resolution.candidate.request;
      return {
        kind: "match",
        backing: "request",
        key: resolution.candidate.key,
        recordId: record.requestId,
        sessionId: record.sessionId,
        allowed: record.allowedActions,
      };
    }
  }
}

function kernelRequestExecution(
  resolution: RequestResolution,
  correlation: ScopedCorrelation | undefined,
  requestedAction: SessionTransition.AllowedAction | "invalid",
): KernelRequestExecution {
  switch (resolution.kind) {
    case "none":
    case "ambiguous":
      // Ambiguity is carried by the decision and rejected before execution.
      return { kind: "none" };
    case "match":
      return {
        kind: "request",
        // findRequestCandidates can return a match only for a scoped correlation.
        correlation: correlation as ScopedCorrelation,
        requestedAction,
        record: resolution.candidate.request,
      };
  }
}

type ChannelResolution = ReturnType<typeof resolveChannelGrant>;

function channelState(
  resolution: ChannelResolution,
  inboundEvidenceOnly: boolean,
): RouteState["channel"] {
  if (resolution === undefined) return undefined;
  if (resolution.inboundTreatment === "drop" || resolution.grant.kind === "blocked_channel") {
    return {
      id: resolution.grant.id,
      kind: "blocked_channel",
      inboundTreatment: "drop",
    };
  }
  if (resolution.grant.kind === "broadcast_channel") {
    return {
      id: resolution.grant.id,
      kind: "broadcast_channel",
      inboundTreatment: "evidence_only",
      ...(resolution.grant.defaultTier === undefined
        ? {}
        : { defaultTier: resolution.grant.defaultTier }),
    };
  }
  return {
    id: resolution.grant.id,
    kind: "trusted_channel",
    // Treatment floor (audit A T1): a channel grant can only RAISE a sender to
    // full_access; it must never override an inbound already marked
    // evidence_only. A re-injected recovery message (unrecoverable original
    // sender) keeps the evidence_only marker to the brain — a monotonic
    // downgrade. This is now a CLOSED hole (S6): the brain consumes
    // inboundTreatment as a hard command-authority restriction — an
    // evidence_only run's tool permission is forced deny-all
    // (execution-runtime/middleware.ts) and the projection seam frames the
    // turn as evidence. The marker is protective, not merely stamped.
    inboundTreatment: inboundEvidenceOnly ? "evidence_only" : resolution.inboundTreatment,
    ...(resolution.grant.defaultTier === undefined
      ? {}
      : { defaultTier: resolution.grant.defaultTier }),
  };
}

function actorState(event: Gateway.DeliveredEvent): RouteState["actor"] {
  const actor = event.meta?.actor;
  const actorId = actor?.actorId;
  const trustTier = actor?.trustTier;
  if (actorId !== undefined && trustTier !== undefined) {
    return { id: actorId, trustTier };
  }

  return undefined;
}

function routedEvent<Event extends Gateway.DeliveredEvent>(
  event: Event,
  resolution: ChannelResolution,
  channel: RouteState["channel"],
): Event {
  if (resolution === undefined || channel === undefined || channel.kind === "blocked_channel") {
    return event;
  }
  const treated = applyChannelGrantTreatment(event, resolution.grant, channel.inboundTreatment);
  return { ...event, ...treated };
}

function blacklistState(
  event: Gateway.DeliveredEvent,
  correlation: ScopedCorrelation | undefined,
): RouteState["blacklist"] {
  const actor = event.meta?.actor;
  const entry = matchBlacklist({
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

function resolveKernelRoute<Event extends Gateway.DeliveredEvent>(
  event: Event,
  surfaceKey: string,
  traceId: string,
  requests: GatewayRouterPorts["requests"],
  at: number,
): KernelRouteResolution<Event> {
  const correlation = parseCorrelation(event);
  const payload = RequestActionPayload.safeParse(event.payload);
  const parsedAction =
    payload.success && "action" in payload.data
      ? SessionTransition.AllowedAction.safeParse(payload.data.action)
      : SessionTransition.AllowedAction.safeParse("report_result");
  const requestedAction = parsedAction.success ? parsedAction.data : "invalid";
  const gatheredRequest = findRequestCandidates(requests.list(), correlation);
  const request = routeRequestState(gatheredRequest);
  const target = targetKey(resolveTarget(event));
  const surfaceSessionId = SurfaceKey.lookup(surfaceKey);
  const blacklist = blacklistState(event, correlation);
  const channelResolution = resolveChannelGrant({
    surface: event.surface,
    workspace: event.workspace,
    channel: event.channel,
    ...(event.userId === undefined ? {} : { sender: event.userId }),
  });
  const channel = channelState(channelResolution, event.meta?.inboundTreatment === "evidence_only");
  const actor = actorState(event);
  const decision = resolveRoute(
    {
      traceId,
      time: at,
      id: event.id,
      surface: event.surface,
      mode: event.mode,
      target,
      requestedAction,
    },
    {
      request,
      ...(blacklist === undefined ? {} : { blacklist }),
      ...(channel === undefined ? {} : { channel }),
      ...(actor === undefined ? {} : { actor }),
      ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
    },
  );
  if (
    decision.outcome === "route" &&
    decision.stage === "surface_default" &&
    decision.sessionId === undefined
  ) {
    const id = SurfaceKey.claim(surfaceKey, crypto.randomUUID());
    decision.sessionId = id;
    decision.factsUsed = decision.factsUsed.map((fact) =>
      fact === "surface.default:new" ? `surface.default:${id}` : fact,
    );
  }
  const requestExecution = kernelRequestExecution(gatheredRequest, correlation, requestedAction);
  return {
    decision,
    event: routedEvent(event, channelResolution, channel),
    requestExecution,
  };
}

// The protocol owns the route stream key, decision equivalence predicate, and
// route.decided fact shape. This recorder owns only the scoped append port.
// A decision is durably appended before projection or execution. On a CAS
// conflict, the fresh decision may proceed only when it is equivalent to the
// recorded decision, including the pinned reply-grant endpoint. Divergence
// and append/read failures fail closed with a typed error; no second fact or
// projection is emitted.
function pinReplyGrantEndpoint(
  decision: Ingress.RoutingDecisionPayload,
  event: Gateway.DeliveredEvent,
): Ingress.RoutingDecisionPayload {
  const actor = event.meta?.actor;
  const endpoint = actor?.endpoint;
  if (
    decision.outcome !== "route" ||
    decision.actorId === undefined ||
    actor?.actorId !== decision.actorId ||
    endpoint === undefined
  ) {
    return decision;
  }
  return {
    ...decision,
    factsUsed: [
      ...decision.factsUsed,
      ...replyGrantEndpointFacts({ channel: endpoint.channel, externalId: endpoint.externalId }),
    ],
  };
}

function recordRouteDecided(
  streamId: string,
  decision: Ingress.RoutingDecisionPayload,
): Ingress.RoutingDecisionPayload {
  // Scoped append port (#707 S8): append + headFact only — the router never
  // holds the master Storage entry (S1/S2: brain surfaces stay unreachable).
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
    // Upcast-on-read: pre-0025 facts carry dead optional fields the strict
    // write schema rejects; the reader strips them. `undefined` means the
    // bytes were never a valid route.decided of any era.
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
    // The recorded decision carries perimeter-resolved authority (actorId,
    // trustTier, inboundTreatment); interpolating either side into the error
    // would disclose identity and policy treatment to whoever triggered the
    // redelivery, so the refusal stays typed and value-free.
    throw new IngressRoutingError(
      "route_replay_divergent",
      "redelivered inbound diverges from its recorded routing decision on an execution- or authority-shaping field",
      decision,
    );
  }
  return decision;
}

// Correlation is read-only (#215): request ambiguity is recorded solely by the
// appended route.decided fact, its published RoutingDecision projection, and
// the typed route_ambiguous rejection — candidates are never mutated on
// lookup.
export function resolveAndRecordRoute<Event extends Gateway.DeliveredEvent>(
  event: Event,
  surfaceKey: string,
  traceId: string,
  publish: BusEvent.Sink["publish"],
  requests: GatewayRouterPorts["requests"],
  at: number,
): KernelRouteResolution<Event> {
  const resolution = resolveKernelRoute(event, surfaceKey, traceId, requests, at);
  const decision = Ingress.Events.RoutingDecision.schema.parse(
    pinReplyGrantEndpoint(resolution.decision, event),
  );
  // Redelivery passes the equivalence gate or fails closed — execution below
  // always uses the fresh decision with its own fresh resolution.
  const effective = recordRouteDecided(Ingress.routeStreamId(event), decision);
  // Observe-only projection — strictly after the append (or after the gated
  // equivalent replay); lossy by contract, published through the injected
  // sink (channels never imports the observation channel). A divergent
  // replay publishes nothing (the gate throws above).
  publish(Ingress.Events.RoutingDecision, effective);
  return { ...resolution, decision: effective };
}
