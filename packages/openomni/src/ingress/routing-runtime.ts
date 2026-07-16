import { Actor, Dispatch, type Ingress, type RoutingDecisionPayload } from "@openomni/protocol";
import {
  BlacklistStore,
  ChannelGrantStore,
  type PendingInteractionStore,
  SurfaceKey,
} from "@openomni/session";
import {
  findPendingInteractions,
  requestedPendingInteractionAction,
} from "../dispatch/pending-interaction-routing.js";
import { applyChannelGrantTreatment } from "./middleware/ingress-authority-channel-grant.js";
import { IngressSessionResolver } from "./session-resolver.js";
import { resolveRoute, type RouteState } from "./resolve-route.js";
import { resolveTarget, targetKey } from "./target.js";

export type KernelRouteResolution = {
  readonly decision: RoutingDecisionPayload;
  readonly event: Ingress.InboundEvent;
  readonly correlation?: Dispatch.Correlation;
  readonly pendingInteraction?: PendingInteractionStore.Record;
};

function parseCorrelation(event: Ingress.InboundEvent): Dispatch.Correlation | undefined {
  const value = event.meta?.correlation;
  return value === undefined ? undefined : Dispatch.Correlation.parse(value);
}

function waitState(correlation: Dispatch.Correlation | undefined): {
  readonly wait: RouteState["wait"];
  readonly pendingInteraction?: PendingInteractionStore.Record;
} {
  if (correlation === undefined) return { wait: { kind: "none" } };
  const matches = findPendingInteractions(correlation);
  if (matches.length === 0) return { wait: { kind: "none" } };
  if (matches.length > 1) {
    return {
      wait: {
        kind: "ambiguous",
        candidateInteractionIds: matches.map((match) => match.id).sort(),
      },
    };
  }
  const match = matches[0];
  if (match === undefined) return { wait: { kind: "none" } };
  return {
    wait: {
      kind: "match",
      interactionId: match.id,
      sessionId: match.sessionId,
      runId: match.workerRunId,
      allowed: match.allowedActions,
      ...(match.targetActorId === undefined ? {} : { targetActorId: match.targetActorId }),
    },
    pendingInteraction: match,
  };
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

function routedEvent(
  event: Ingress.InboundEvent,
  resolution: ChannelResolution,
  channel: RouteState["channel"],
): Ingress.InboundEvent {
  if (
    event.mode === "internal" ||
    resolution === undefined ||
    channel === undefined ||
    channel.kind === "blocked_channel"
  ) {
    return event;
  }
  return applyChannelGrantTreatment(event, resolution.grant, channel.inboundTreatment);
}

function blacklistState(
  event: Ingress.InboundEvent,
  correlation: Dispatch.Correlation | undefined,
): RouteState["blacklist"] {
  const actor = event.meta?.actor;
  const entry = BlacklistStore.match({
    actorId: typeof actor?.actorId === "string" ? actor.actorId : undefined,
    endpointId:
      correlation?.endpointId ??
      (typeof actor?.endpointId === "string" ? actor.endpointId : undefined),
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

export function resolveKernelRoute(
  event: Ingress.InboundEvent,
  traceId: string,
): KernelRouteResolution {
  const correlation = parseCorrelation(event);
  const wait = waitState(correlation);
  const target = targetKey(resolveTarget(event));
  const surfaceSessionId = SurfaceKey.lookup(IngressSessionResolver.extractSurfaceKey(event));
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
  const decision = resolveRoute(
    {
      traceId,
      time: Date.now(),
      id: event.id,
      surface: event.surface,
      mode: event.mode,
      target,
      ...(correlation === undefined
        ? {}
        : { requestedAction: requestedPendingInteractionAction(event.payload) }),
    },
    {
      wait: wait.wait,
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
  return {
    decision,
    event: routedEvent(event, channelResolution, channel),
    ...(correlation === undefined ? {} : { correlation }),
    ...(wait.pendingInteraction === undefined
      ? {}
      : { pendingInteraction: wait.pendingInteraction }),
  };
}
