import {
  Actor,
  Dispatch,
  type Communication,
  type Ingress,
  type RoutingDecisionPayload,
  type Wait,
} from "@openomni/protocol";
import { BlacklistStore, ChannelGrantStore, SurfaceKey } from "@openomni/session";
import {
  findWaitCandidates,
  requestedWaitAction,
  type RequestedWaitAction,
  type WaitResolution,
} from "../wait/index.js";
import { applyChannelGrantTreatment } from "./middleware/ingress-authority.js";
import { resolveRoute, type RouteState } from "./resolve-route.js";
import { IngressSessionResolver } from "./session-resolver.js";
import { resolveTarget, targetKey } from "./target.js";

export type KernelWaitExecution =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "wait";
      // Optional: after recordDeliveryReceipt re-keys a wait to the platform
      // message id, a channel may deliver the reply matched on
      // externalMessageId alone, with no correlation envelope.
      correlation?: Dispatch.Correlation;
      requestedAction: RequestedWaitAction;
      record: Wait.Record;
    }>
  | Readonly<{
      kind: "pending_interaction";
      correlation: Dispatch.Correlation;
      requestedAction: RequestedWaitAction;
      record: Communication.PendingInteraction.Record;
    }>
  | Readonly<{
      kind: "pending_ask";
      record: Communication.PendingAsk.Record;
    }>
  | Readonly<{ kind: "ambiguous" }>;

export type KernelRouteResolution<Event extends Ingress.InboundEvent = Ingress.InboundEvent> =
  Readonly<{
    decision: RoutingDecisionPayload;
    event: Event;
    waitExecution: KernelWaitExecution;
    selectedTarget: Ingress.Target;
  }>;

function parseCorrelation(event: Ingress.InboundEvent): Dispatch.Correlation | undefined {
  const value = event.meta?.correlation;
  return value === undefined ? undefined : Dispatch.Correlation.parse(value);
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
  correlation: Dispatch.Correlation | undefined,
  requestedAction: RequestedWaitAction,
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
          return {
            kind: "wait",
            ...(correlation === undefined ? {} : { correlation }),
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
  decision: RoutingDecisionPayload,
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

function channelState(resolution: ChannelResolution): RouteState["channel"] {
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
    inboundTreatment: resolution.inboundTreatment,
    ...(resolution.grant.defaultTier === undefined
      ? {}
      : { defaultTier: resolution.grant.defaultTier }),
  };
}

function actorState(event: Ingress.InboundEvent): RouteState["actor"] {
  const actor = event.meta?.actor;
  const actorId = typeof actor?.actorId === "string" ? actor.actorId : undefined;
  const trustTier = Actor.TrustTier.safeParse(actor?.trustTier);
  if (actorId !== undefined && trustTier.success) {
    return { id: actorId, trustTier: trustTier.data, registered: true };
  }

  return undefined;
}

function routedEvent<Event extends Ingress.InboundEvent>(
  event: Event,
  resolution: ChannelResolution,
  channel: RouteState["channel"],
): Event {
  if (
    event.mode === "internal" ||
    resolution === undefined ||
    channel === undefined ||
    channel.kind === "blocked_channel"
  ) {
    return event;
  }
  const treated = applyChannelGrantTreatment(event, resolution.grant, channel.inboundTreatment);
  return { ...event, ...treated };
}

function blacklistState(
  event: Ingress.InboundEvent,
  correlation: Dispatch.Correlation | undefined,
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
  decision: RoutingDecisionPayload,
  wait: RouteState["wait"],
  requestedAction: RequestedWaitAction,
): RoutingDecisionPayload {
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

export function resolveKernelRoute<Event extends Ingress.InboundEvent>(
  event: Event,
  traceId: string,
): KernelRouteResolution<Event> {
  const correlation = parseCorrelation(event);
  const requestedAction = requestedWaitAction(event.payload);
  const gatheredWait = findWaitCandidates({
    ...(correlation === undefined ? {} : { correlation }),
    externalMessageId: event.id,
  });
  const wait = routeWaitState(gatheredWait);
  const surfaceDefaultTarget = resolveTarget(event);
  const target = targetKey(surfaceDefaultTarget);
  const surfaceSessionId =
    event.runtime?.durableSessionId ??
    SurfaceKey.lookup(IngressSessionResolver.extractSurfaceKey(event));
  const blacklist = blacklistState(event, correlation);
  const channelResolution =
    event.mode === "direct"
      ? ChannelGrantStore.resolve({
          surface: event.surface,
          workspace: event.workspace,
          channel: event.channel,
        })
      : undefined;
  const channel = channelState(channelResolution);
  const actor = event.mode === "direct" ? actorState(event) : undefined;
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
      ...(event.mode === "internal"
        ? { systemActorId: `system:${event.surface}` }
        : {
            ...(channel === undefined ? {} : { channel }),
            ...(actor === undefined ? {} : { actor }),
          }),
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
