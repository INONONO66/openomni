import {
  Actor,
  type Gateway,
  Ingress,
  Wait,
  extractSurfaceKey,
  resolveTarget,
  targetKey,
  type BusEvent,
  type Communication,
} from "@openomni/protocol";
import { BlacklistStore, ChannelGrantStore, LedgerAppend, SurfaceKey } from "@openomni/ledger";
import { applyChannelGrantTreatment } from "./authority.js";
import {
  replyGrantEndpointFacts,
  replyGrantEndpointFromFacts,
} from "./messaging/reply-grant.js";
import { resolveRoute, type RouteState } from "./resolve-route.js";
import { findWaitCandidates, type WaitResolution } from "./wait/index.js";

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

/**
 * #498 C3: ingress correlation claims reuse THE one Wait.Correlation shape.
 * A claim envelope must carry its endpoint+channel scope pins — the same
 * requirement Command.Input enforces — kept as a local type-narrowing refine
 * at this call site so no second correlation shape is exported.
 */
type ScopedCorrelation = Wait.Correlation & Readonly<{ endpointId: string; channelId: string }>;
const ScopedCorrelationClaim = Wait.Correlation.refine(
  (value): value is ScopedCorrelation =>
    value.endpointId !== undefined && value.channelId !== undefined,
  { message: "correlation claims require endpointId and channelId" },
);

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

type KernelWaitExecution =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "wait";
      // Required: a wait match can only come from resolveWaitTier, which
      // refuses without a correlation envelope (externalMessageId re-keying
      // feeds pendingAsk queries, never this tier) — the old optionality
      // weakened the sender-match evidence below its real invariant.
      correlation: ScopedCorrelation;
      requestedAction: Wait.RequestedWaitAction;
      record: Wait.Record;
    }>
  | Readonly<{
      kind: "pending_interaction";
      correlation: ScopedCorrelation;
      requestedAction: Wait.RequestedWaitAction;
      record: Communication.PendingInteraction.Record;
    }>
  | Readonly<{
      kind: "pending_ask";
      record: Communication.PendingAsk.Record;
    }>
  | Readonly<{ kind: "ambiguous" }>;

export type KernelRouteResolution<Event extends Gateway.DeliveredEvent = Gateway.DeliveredEvent> =
  Readonly<{
    decision: Ingress.RoutingDecisionPayload;
    event: Event;
    waitExecution: KernelWaitExecution;
    selectedTarget: Ingress.Target;
  }>;

function parseCorrelation(event: Gateway.DeliveredEvent): ScopedCorrelation | undefined {
  const value = event.meta?.correlation;
  return value === undefined ? undefined : ScopedCorrelationClaim.parse(value);
}

function routeWaitState(resolution: WaitResolution): RouteState["wait"] {
  switch (resolution.kind) {
    case "none":
      return { kind: "none" };
    case "ambiguous":
      return {
        kind: "ambiguous",
        candidateInteractionIds: resolution.candidates.map((candidate) => candidate.key),
      };
    case "match":
      switch (resolution.candidate.source) {
        case "wait": {
          const record = resolution.candidate.wait;
          return {
            kind: "match",
            backing: "wait",
            key: resolution.candidate.key,
            recordId: record.id,
            owner: record.ownerRef,
            allowed: record.allowedActions,
          };
        }
        case "pending_interaction": {
          const record = resolution.candidate.record;
          return {
            kind: "match",
            backing: "pending_interaction",
            key: resolution.candidate.key,
            recordId: record.id,
            sessionId: record.sessionId,
            runId: record.workerRunId,
            allowed: record.allowedActions,
            ...(record.targetActorId === undefined ? {} : { targetActorId: record.targetActorId }),
          };
        }
        case "pending_ask": {
          const record = resolution.candidate.record;
          return {
            kind: "match",
            backing: "pending_ask",
            key: resolution.candidate.key,
            recordId: record.id,
            sessionId: record.originSessionId,
            ...(record.originRunId === undefined ? {} : { runId: record.originRunId }),
          };
        }
      }
  }
}

function kernelWaitExecution(
  resolution: WaitResolution,
  correlation: ScopedCorrelation | undefined,
  requestedAction: Wait.RequestedWaitAction,
): KernelWaitExecution {
  switch (resolution.kind) {
    case "none":
      return { kind: "none" };
    case "ambiguous":
      return { kind: "ambiguous" };
    case "match":
      switch (resolution.candidate.source) {
        case "pending_ask":
          return { kind: "pending_ask", record: resolution.candidate.record };
        case "wait":
          if (correlation === undefined) {
            throw new TypeError("wait match requires correlation");
          }
          return {
            kind: "wait",
            correlation,
            requestedAction,
            record: resolution.candidate.wait,
          };
        case "pending_interaction":
          if (correlation === undefined) {
            throw new TypeError("pending interaction match requires correlation");
          }
          return {
            kind: "pending_interaction",
            correlation,
            requestedAction,
            record: resolution.candidate.record,
          };
      }
  }
}

function selectedRouteTarget(
  decision: Ingress.RoutingDecisionPayload,
  waitExecution: KernelWaitExecution,
  surfaceDefault: Ingress.Target,
): Ingress.Target {
  if (decision.outcome !== "route" || decision.stage !== "wait_correlation") {
    return surfaceDefault;
  }
  if (waitExecution.kind === "pending_ask" || waitExecution.kind === "wait") {
    return { kind: "resident" };
  }
  if (waitExecution.kind === "pending_interaction") {
    return { kind: "worker", sessionId: waitExecution.record.sessionId };
  }
  throw new TypeError("wait-correlation route has no executable wait target");
}

type ChannelResolution = ReturnType<typeof ChannelGrantStore.resolve>;

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
  const actorId = typeof actor?.actorId === "string" ? actor.actorId : undefined;
  const trustTier = Actor.TrustTier.safeParse(actor?.trustTier);
  if (actorId !== undefined && trustTier.success) {
    return { id: actorId, trustTier: trustTier.data, registered: true };
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

function rejectUnsupportedPendingInteractionAction(
  decision: Ingress.RoutingDecisionPayload,
  wait: RouteState["wait"],
  requestedAction: Wait.RequestedWaitAction,
): Ingress.RoutingDecisionPayload {
  if (
    decision.outcome !== "route" ||
    decision.stage !== "wait_correlation" ||
    wait.kind !== "match" ||
    wait.backing !== "pending_interaction" ||
    requestedAction === "report_result" ||
    requestedAction === "ask_clarification"
  ) {
    return decision;
  }
  return {
    traceId: decision.traceId,
    time: decision.time,
    inboundId: decision.inboundId,
    surface: decision.surface,
    mode: decision.mode,
    stage: "channel_ceiling",
    outcome: "block",
    reason: `Pending interaction action ${requestedAction} is unsupported by ingress execution`,
    factsUsed: [
      `wait:${wait.key}`,
      `wait.action:${requestedAction}`,
      "wait.action:unsupported_ingress_command",
    ],
  };
}

function resolveKernelRoute<Event extends Gateway.DeliveredEvent>(
  event: Event,
  traceId: string,
): KernelRouteResolution<Event> {
  const correlation = parseCorrelation(event);
  const requestedAction = Wait.requestedWaitAction(event.payload);
  const gatheredWait = findWaitCandidates({
    ...(correlation === undefined ? {} : { correlation }),
    externalMessageId: event.id,
  });
  const wait = routeWaitState(gatheredWait);
  const surfaceDefaultTarget = resolveTarget(event);
  const target = targetKey(surfaceDefaultTarget);
  const surfaceSessionId =
    event.activation?.durableSessionId ?? SurfaceKey.lookup(extractSurfaceKey(event));
  const blacklist = blacklistState(event, correlation);
  const channelResolution = ChannelGrantStore.resolve({
    surface: event.surface,
    workspace: event.workspace,
    channel: event.channel,
  });
  const channel = channelState(channelResolution, event.meta?.inboundTreatment === "evidence_only");
  const actor = actorState(event);
  const resolvedDecision = resolveRoute(
    {
      traceId,
      time: Date.now(),
      id: event.id,
      surface: event.surface,
      mode: event.mode,
      target,
      requestedAction,
    },
    {
      wait,
      ...(blacklist === undefined ? {} : { blacklist }),
      ...(channel === undefined ? {} : { channel }),
      ...(actor === undefined ? {} : { actor }),
      ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
    },
  );
  const decision = rejectUnsupportedPendingInteractionAction(
    resolvedDecision,
    wait,
    requestedAction,
  );
  const waitExecution = kernelWaitExecution(gatheredWait, correlation, requestedAction);
  return {
    decision,
    event: routedEvent(event, channelResolution, channel),
    waitExecution,
    selectedTarget: selectedRouteTarget(decision, waitExecution, surfaceDefaultTarget),
  };
}

// The route owner-stream key (#510 F1) and the replay equivalence gate
// (#510 F2) are the PURE parts of this recorder, hoisted to protocol
// (`Ingress.routeStreamId` / `Ingress.routeDecisionsEquivalent` /
// `Ingress.routeDecidedFact`) so this external arm and the brain's internal
// arm cannot drift. Only the append below stays per-side — it holds the
// router's scoped `LedgerAppend.port()` and throws the channels-local typed
// error.

// #510 C3 ruling 1 — the routing decision is a decision-class fact on the
// single-fact owner stream `route:<surface>:<workspace>:<channel>:<id>`
// (expectedHead 0), awaited durably BEFORE anything acts on the decision:
// the observe-only Bus publish, the typed terminal rejection, and
// wait/handler execution all follow the append. No record, no action — with
// one EQUIVALENCE-GATED replay carve-out (review fix F2): a cas_conflict
// means this inbound was already decided, and a redelivered inbound may
// proceed only when the fresh decision matches the recorded one on every
// execution-shaping field (see routeDecisionsEquivalent). Equivalent →
// execution proceeds with the FRESH resolution and fresh decision (identical
// anyway), so recorded payload and fresh waitExecution/selectedTarget can
// never mix: an accepted route re-executes idempotently (the wait fold's
// already_resolved short-circuit re-delivers to the owner — the #519
// attach/deliver crash-window recovery), a terminal decision repeats the
// same typed rejection. Divergent → typed route_replay_divergent, fail
// closed: no action, no second fact, nothing published. Only append
// INFRASTRUCTURE failure (missing sub-adapter, failed append/read, foreign
// or unparsable recorded fact) fails closed as route_record_failed.
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
    recorded = Ingress.Events.RoutingDecision.schema.parse(fact.data);
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
    throw new IngressRoutingError(
      "route_replay_divergent",
      `redelivered inbound diverges from its recorded routing decision: recorded ${recorded.stage}/${recorded.outcome}, fresh ${decision.stage}/${decision.outcome}`,
      decision,
    );
  }
  return decision;
}

// Correlation is read-only (#215): wait ambiguity is recorded solely by the
// appended route.decided fact, its published RoutingDecision projection, and
// the typed route_ambiguous rejection — frozen legacy rows are never mutated
// on lookup.
export function resolveAndRecordRoute<Event extends Gateway.DeliveredEvent>(
  event: Event,
  traceId: string,
  publish: BusEvent.Sink["publish"],
): KernelRouteResolution<Event> {
  const resolution = resolveKernelRoute(event, traceId);
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
