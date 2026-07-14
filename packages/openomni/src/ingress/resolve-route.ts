import type { Actor, RoutingDecisionPayload } from "@openomni/protocol";

export type RouteInbound = {
  readonly traceId: string;
  readonly time: number;
  readonly id: string;
  readonly surface: string;
  readonly mode: "direct" | "internal";
  readonly target: string;
  readonly requestedAction?: string;
};

type RouteWait =
  | { readonly kind: "none" }
  | {
      readonly kind: "match";
      readonly interactionId: string;
      readonly sessionId: string;
      readonly runId: string;
      readonly allowed: readonly string[];
      readonly targetActorId?: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly candidateInteractionIds: readonly string[];
    };

type RouteChannel =
  | {
      readonly id: string;
      readonly kind: "trusted_channel";
      readonly inboundTreatment: "full_access" | "evidence_only";
      readonly defaultTier?: Actor.TrustTier;
    }
  | {
      readonly id: string;
      readonly kind: "broadcast_channel";
      readonly inboundTreatment: "evidence_only";
      readonly defaultTier?: Actor.TrustTier;
    }
  | {
      readonly id: string;
      readonly kind: "blocked_channel";
      readonly inboundTreatment: "drop";
    };

type RouteActor = {
  readonly id: string;
  readonly trustTier: Actor.TrustTier;
  readonly registered: true;
};

export type RouteState = {
  readonly blacklist?: {
    readonly id: string;
    readonly kind: Actor.BlacklistKind;
    readonly reason?: string;
  };
  readonly wait: RouteWait;
  readonly channel?: RouteChannel;
  readonly actor?: RouteActor;
  readonly surfaceSessionId?: string;
  readonly systemActorId?: string;
};

function unreachable(_value: never): never {
  throw new TypeError("Unreachable routing state");
}

export function resolveRoute(inbound: RouteInbound, state: RouteState): RoutingDecisionPayload {
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

  const waitFacts: string[] = [];
  switch (state.wait.kind) {
    case "none":
      waitFacts.push("wait:none");
      break;
    case "ambiguous":
      return {
        ...common,
        stage: "wait_correlation",
        outcome: "ambiguous",
        candidateInteractionIds: [...state.wait.candidateInteractionIds],
        reason: "Multiple pending interactions matched the inbound message",
        factsUsed: state.wait.candidateInteractionIds.map((id) => `wait.candidate:${id}`),
      };
    case "match": {
      const action = inbound.requestedAction;
      if (action !== undefined && state.wait.allowed.includes(action)) {
        return {
          ...common,
          stage: "wait_correlation",
          outcome: "route",
          target: `worker-session:${state.wait.sessionId}`,
          sessionId: state.wait.sessionId,
          runId: state.wait.runId,
          pendingInteractionId: state.wait.interactionId,
          ...(state.wait.targetActorId === undefined ? {} : { actorId: state.wait.targetActorId }),
          trustTier: "assigned_worker",
          inboundTreatment: "full_access",
          reason: "Inbound action matched a pending interaction",
          factsUsed: [
            `wait:${state.wait.interactionId}`,
            `wait.action:${action}`,
            `wait.session:${state.wait.sessionId}`,
            `wait.run:${state.wait.runId}`,
          ],
        };
      }
      waitFacts.push(
        `wait:${state.wait.interactionId}`,
        `wait.action:${action ?? "missing"}`,
        "wait.action:disallowed",
      );
      break;
    }
    default:
      return unreachable(state.wait);
  }

  if (inbound.mode === "internal") {
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

  if (state.channel === undefined) {
    return {
      ...common,
      stage: "channel_ceiling",
      outcome: "block",
      reason: "External inbound message has no channel grant",
      factsUsed: [...waitFacts, "channel:missing"],
    };
  }

  switch (state.channel.kind) {
    case "blocked_channel":
      return {
        ...common,
        stage: "channel_ceiling",
        outcome: "block",
        inboundTreatment: state.channel.inboundTreatment,
        reason: "Channel grant blocks inbound messages",
        factsUsed: [
          ...waitFacts,
          `channel:${state.channel.id}`,
          `channel.kind:${state.channel.kind}`,
          `channel.treatment:${state.channel.inboundTreatment}`,
        ],
      };
    case "broadcast_channel":
    case "trusted_channel":
      break;
    default:
      return unreachable(state.channel);
  }

  const channelFacts = [
    ...waitFacts,
    `channel:${state.channel.id}`,
    `channel.kind:${state.channel.kind}`,
    `channel.treatment:${state.channel.inboundTreatment}`,
  ];
  const actorId = state.actor?.id;
  const trustTier = state.actor?.trustTier ?? state.channel.defaultTier;

  if (trustTier === undefined) {
    return {
      ...common,
      stage: "actor_identity",
      outcome: "block",
      reason: "Inbound actor is unknown and the channel has no default trust tier",
      factsUsed: [...channelFacts, "actor:unknown", "channel.default-tier:missing"],
    };
  }

  return {
    ...common,
    stage: "surface_default",
    outcome: "route",
    target: inbound.target,
    ...(state.surfaceSessionId === undefined ? {} : { sessionId: state.surfaceSessionId }),
    ...(actorId === undefined ? {} : { actorId }),
    trustTier,
    inboundTreatment: state.channel.inboundTreatment,
    reason: "Inbound message routed to the surface session",
    factsUsed: [
      ...channelFacts,
      ...(actorId === undefined
        ? [`channel.default-tier:${trustTier}`]
        : [`actor:${actorId}`, `actor.trust-tier:${trustTier}`]),
      state.surfaceSessionId === undefined
        ? "surface.default:new"
        : `surface.default:${state.surfaceSessionId}`,
      `target:${inbound.target}`,
    ],
  };
}
