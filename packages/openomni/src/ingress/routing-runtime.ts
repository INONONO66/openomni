import {
  Actor,
  Dispatch,
  type Ingress,
  type RoutingDecisionPayload,
  Wait,
} from "@openomni/protocol";
import { requestedPendingInteractionAction } from "../dispatch/pending-interaction-routing.js";
import {
  applyChannelGrantTreatment,
  resolveInboundTreatment,
} from "./middleware/ingress-authority-channel-grant.js";
import {
  authoritySourceFacts,
  authoritySourceRefs,
  type AuthorityProjectionQueryPort,
  type AuthoritySourceRefs,
} from "./actor-resolver.js";
import { resolveRoute, type RouteState } from "./resolve-route.js";
import { resolveTarget, targetKey } from "./target.js";
import {
  resolveWaitCorrelation,
  type DurableWaitV1,
  type WaitCorrelationEffect,
  type WaitCorrelationResolution,
  type WaitKernelService,
} from "./wait-correlation.js";

export type KernelWaitExecution =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "pending_interaction";
      correlation: Dispatch.Correlation;
      requestedAction: Wait.AllowedActionV1;
      wait: DurableWaitV1 & Readonly<{ route: { kind: "worker" } }>;
    }>
  | Readonly<{
      kind: "pending_ask";
      wait: DurableWaitV1 & Readonly<{ route: { kind: "resident" } }>;
    }>
  | Readonly<{ kind: "ambiguous" }>;

export interface RoutingKernelPorts {
  readonly authorityQueries: AuthorityProjectionQueryPort;
  readonly waits: WaitKernelService;
}

export type KernelRouteResolution<Event extends Ingress.InboundEvent = Ingress.InboundEvent> =
  Readonly<{
    decision: RoutingDecisionPayload;
    event: Event;
    waitExecution: KernelWaitExecution;
    waitEffect: WaitCorrelationEffect;
    selectedTarget: Ingress.Target;
  }>;

function parseCorrelation(event: Ingress.InboundEvent): Dispatch.Correlation | undefined {
  const value = event.meta?.correlation;
  return value === undefined ? undefined : Dispatch.Correlation.parse(value);
}

function nativeWaitCorrelation(correlation: Dispatch.Correlation | undefined): Readonly<{
  endpointId?: string;
  channelId?: string;
  correlation?: Wait.CorrelationV1;
}> {
  if (correlation === undefined) return {};
  const nativeCorrelation = {
    version: "wait-correlation-v1" as const,
    ...(correlation.tokenHash === undefined ? {} : { tokenHash: correlation.tokenHash }),
    ...(correlation.threadId === undefined ? {} : { threadId: correlation.threadId }),
    ...(correlation.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: correlation.replyToMessageId }),
    ...(correlation.externalConversationId === undefined
      ? {}
      : { externalConversationId: correlation.externalConversationId }),
  };
  const parsed = Wait.CorrelationV1.safeParse(nativeCorrelation);
  return {
    endpointId: correlation.endpointId,
    channelId: correlation.channelId,
    ...(parsed.success ? { correlation: parsed.data } : {}),
  };
}

function routeWaitState(resolution: WaitCorrelationResolution): RouteState["wait"] {
  switch (resolution.kind) {
    case "none":
      return { kind: "none" };
    case "ambiguous":
      return {
        kind: "ambiguous",
        candidateInteractionIds: resolution.candidates.map((candidate) => candidate.key),
      };
    case "match": {
      const { key, wait } = resolution.candidate;
      switch (wait.route.kind) {
        case "worker":
          return {
            kind: "match",
            backing: "pending_interaction",
            key,
            recordId: wait.waitId,
            sessionId: wait.route.sessionId,
            runId: wait.route.runId,
            allowed: wait.opened.allowedActions,
            ...(wait.opened.targetActorId === undefined
              ? {}
              : { targetActorId: wait.opened.targetActorId }),
          };
        case "resident":
          return {
            kind: "match",
            backing: "pending_ask",
            key,
            recordId: wait.waitId,
            sessionId: wait.route.sessionId,
            ...(wait.route.runId === undefined ? {} : { runId: wait.route.runId }),
          };
        default: {
          const unreachable: never = wait.route;
          throw new TypeError(`Unreachable Wait route: ${String(unreachable)}`);
        }
      }
    }
    default: {
      const unreachable: never = resolution;
      throw new TypeError(`Unreachable Wait correlation resolution: ${String(unreachable)}`);
    }
  }
}

function kernelWaitExecution(
  resolution: WaitCorrelationResolution,
  correlation: Dispatch.Correlation | undefined,
  requestedAction: Wait.AllowedActionV1,
): KernelWaitExecution {
  switch (resolution.kind) {
    case "none":
      return { kind: "none" };
    case "ambiguous":
      return { kind: "ambiguous" };
    case "match":
      switch (resolution.candidate.wait.route.kind) {
        case "resident":
          return {
            kind: "pending_ask",
            wait: resolution.candidate.wait as DurableWaitV1 &
              Readonly<{ route: { kind: "resident" } }>,
          };
        case "worker":
          if (correlation === undefined) {
            throw new TypeError("worker Wait match requires correlation");
          }
          return {
            kind: "pending_interaction",
            correlation,
            requestedAction,
            wait: resolution.candidate.wait as DurableWaitV1 &
              Readonly<{ route: { kind: "worker" } }>,
          };
        default: {
          const unreachable: never = resolution.candidate.wait.route;
          throw new TypeError(`Unreachable Wait route: ${String(unreachable)}`);
        }
      }
    default: {
      const unreachable: never = resolution;
      throw new TypeError(`Unreachable Wait correlation resolution: ${String(unreachable)}`);
    }
  }
}

function selectWaitEffect(
  decision: RoutingDecisionPayload,
  gathered: WaitCorrelationResolution,
): WaitCorrelationEffect {
  return decision.stage === "wait_correlation" &&
    decision.outcome === "ambiguous" &&
    gathered.kind === "ambiguous"
    ? { kind: "stage_ambiguity", candidates: gathered.candidates }
    : { kind: "none" };
}

function selectedRouteTarget(
  decision: RoutingDecisionPayload,
  waitExecution: KernelWaitExecution,
  surfaceDefault: Ingress.Target,
): Ingress.Target {
  if (decision.outcome !== "route" || decision.stage !== "wait_correlation") {
    return surfaceDefault;
  }
  if (waitExecution.kind === "pending_ask") return { kind: "resident" };
  if (waitExecution.kind === "pending_interaction") {
    return { kind: "worker", sessionId: waitExecution.wait.route.sessionId };
  }
  throw new TypeError("wait-correlation route has no executable wait target");
}

type ChannelResolution = Readonly<{
  grant: Actor.ChannelGrant;
  inboundTreatment: Actor.InboundTreatment;
  evidence: AuthoritySourceRefs;
}>;

function channelState(resolution: ChannelResolution | undefined): RouteState["channel"] {
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
  resolution: ChannelResolution | undefined,
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

async function blacklistState(
  event: Ingress.InboundEvent,
  correlation: Dispatch.Correlation | undefined,
  queries: AuthorityProjectionQueryPort,
): Promise<Readonly<{ state: RouteState["blacklist"]; evidence: AuthoritySourceRefs }>> {
  const actor = event.meta?.actor;
  const endpointId =
    (typeof actor?.endpointId === "string" ? actor.endpointId : undefined) ??
    correlation?.endpointId;
  const result = await queries.query({
    kind: "authority.blacklist_match",
    ...(typeof actor?.actorId === "string" ? { actorId: actor.actorId } : {}),
    ...(endpointId === undefined ? {} : { endpointId }),
    channel: correlation?.channelId ?? event.surface,
    candidates: [
      event.surface,
      ...(event.channel === undefined ? [] : [event.channel]),
      ...(correlation === undefined ? [] : [correlation.channelId]),
      `${event.surface}:${event.workspace ?? ""}:${event.channel ?? ""}`,
    ],
  });
  if (result.kind !== "authority.blacklist_match") {
    throw new TypeError("authority blacklist query returned the wrong projection kind");
  }
  return {
    state:
      result.entry === null
        ? undefined
        : {
            id: result.entry.id,
            kind: result.entry.kind,
            reason: result.entry.reason ?? `blacklist.${result.entry.kind}.${result.entry.value}`,
          },
    evidence: result,
  };
}

async function channelResolution(
  event: Ingress.InboundEvent,
  queries: AuthorityProjectionQueryPort,
): Promise<Readonly<{ resolution?: ChannelResolution; evidence: AuthoritySourceRefs }>> {
  const result = await queries.query({
    kind: "authority.channel_grant",
    surface: event.surface,
    ...(event.workspace === undefined ? {} : { workspace: event.workspace }),
    ...(event.channel === undefined ? {} : { channel: event.channel }),
  });
  if (result.kind !== "authority.channel_grant") {
    throw new TypeError("authority channel query returned the wrong projection kind");
  }
  return {
    ...(result.grant === null
      ? {}
      : {
          resolution: {
            grant: result.grant,
            inboundTreatment:
              result.grant.kind === "broadcast_channel"
                ? "evidence_only"
                : result.grant.kind === "blocked_channel"
                  ? "drop"
                  : resolveInboundTreatment(result.grant),
            evidence: result,
          },
        }),
    evidence: result,
  };
}

function withAuthorityEvidence(
  decision: RoutingDecisionPayload,
  refs: readonly AuthoritySourceRefs[],
): RoutingDecisionPayload {
  return {
    ...decision,
    factsUsed: [...decision.factsUsed, ...refs.flatMap((source) => authoritySourceFacts(source))],
  };
}

function rejectUnsupportedPendingInteractionAction(
  decision: RoutingDecisionPayload,
  wait: RouteState["wait"],
  requestedAction: Wait.AllowedActionV1,
): RoutingDecisionPayload {
  if (wait.kind !== "match" || wait.backing !== "pending_interaction") return decision;
  const supported = requestedAction === "report_result" || requestedAction === "ask_clarification";
  const matchedRoute = decision.outcome === "route" && decision.stage === "wait_correlation";
  if (supported && matchedRoute) return decision;
  const reason = supported
    ? `Pending interaction action ${requestedAction} is not allowed by the matched Wait`
    : `Pending interaction action ${requestedAction} is unsupported by ingress execution`;
  const reasonFact = supported
    ? "wait.action:disallowed"
    : "wait.action:unsupported_ingress_command";
  return {
    traceId: decision.traceId,
    time: decision.time,
    inboundId: decision.inboundId,
    surface: decision.surface,
    mode: decision.mode,
    stage: "channel_ceiling",
    outcome: "block",
    reason,
    factsUsed: [`wait:${wait.key}`, `wait.action:${requestedAction}`, reasonFact],
  };
}

export async function resolveKernelRoute<Event extends Ingress.InboundEvent>(
  event: Event,
  traceId: string,
  ports: RoutingKernelPorts,
): Promise<KernelRouteResolution<Event>> {
  const correlation = parseCorrelation(event);
  const requestedAction = requestedPendingInteractionAction(event.payload);
  const gatheredWait = await resolveWaitCorrelation(
    ports.waits,
    nativeWaitCorrelation(correlation),
  );
  const wait = routeWaitState(gatheredWait);
  const surfaceDefaultTarget = resolveTarget(event);
  const target = targetKey(surfaceDefaultTarget);
  const surfaceSessionId = event.runtime?.durableSessionId;
  const blacklistResult = await blacklistState(event, correlation, ports.authorityQueries);
  const channelResult =
    event.mode === "direct" ? await channelResolution(event, ports.authorityQueries) : undefined;
  const channel = channelState(channelResult?.resolution);
  const actor = event.mode === "direct" ? actorState(event) : undefined;
  const actorEvidence = authoritySourceRefs(event.meta?.authorityEvidence);
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
      ...(blacklistResult.state === undefined ? {} : { blacklist: blacklistResult.state }),
      ...(event.mode === "internal"
        ? { systemActorId: `system:${event.surface}` }
        : {
            ...(channel === undefined ? {} : { channel }),
            ...(actor === undefined ? {} : { actor }),
          }),
      ...(surfaceSessionId === undefined ? {} : { surfaceSessionId }),
    },
  );
  const decision = withAuthorityEvidence(
    rejectUnsupportedPendingInteractionAction(resolvedDecision, wait, requestedAction),
    [
      blacklistResult.evidence,
      ...(channelResult === undefined ? [] : [channelResult.evidence]),
      ...(actorEvidence === undefined ? [] : [actorEvidence]),
    ],
  );
  const waitExecution = kernelWaitExecution(gatheredWait, correlation, requestedAction);
  return {
    decision,
    event: routedEvent(event, channelResult?.resolution, channel),
    waitExecution,
    selectedTarget: selectedRouteTarget(decision, waitExecution, surfaceDefaultTarget),
    waitEffect: selectWaitEffect(decision, gatheredWait),
  };
}
