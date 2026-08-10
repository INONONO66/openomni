import type { Actor, RoutingDecisionPayload, Wait } from "@openomni/protocol";

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
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "match";
      backing: "wait";
      key: string;
      recordId: string;
      owner: Wait.OwnerRef;
      allowed: readonly string[];
    }>
  | Readonly<{
      kind: "match";
      backing: "pending_interaction";
      key: string;
      recordId: string;
      sessionId: string;
      runId: string;
      allowed: readonly string[];
      targetActorId?: string;
    }>
  | Readonly<{
      kind: "match";
      backing: "pending_ask";
      key: string;
      recordId: string;
      sessionId: string;
      runId?: string;
    }>
  | Readonly<{
      kind: "ambiguous";
      candidateInteractionIds: readonly string[];
    }>;

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
        reason: "Multiple pending waits matched the inbound message",
        factsUsed: state.wait.candidateInteractionIds.map((id) => `wait.candidate:${id}`),
      };
    case "match": {
      switch (state.wait.backing) {
        case "wait": {
          const action = inbound.requestedAction;
          if (action === undefined || !state.wait.allowed.includes(action)) {
            // Fail closed: a matched durable wait never falls through to
            // surface routing — a disallowed action is a typed block, mirroring
            // the owner gate below.
            return {
              ...common,
              stage: "wait_correlation",
              outcome: "block",
              reason: "Matched wait does not allow the requested action",
              factsUsed: [
                `wait:${state.wait.key}`,
                `wait.action:${action ?? "missing"}`,
                "wait.action:disallowed",
              ],
            };
          }
          if (state.wait.owner.kind !== "session") {
            // Fail closed: a matched wait must never fall through to surface
            // routing, and workItem-owned resumption has no ingress delivery
            // path yet (#216/#217 wire it).
            return {
              ...common,
              stage: "wait_correlation",
              outcome: "block",
              reason: "Matched wait owner has no ingress delivery path",
              factsUsed: [
                `wait:${state.wait.key}`,
                `wait.action:${action}`,
                `wait.owner:${state.wait.owner.kind}:${state.wait.owner.id}`,
                "wait.owner:unsupported_ingress_delivery",
              ],
            };
          }
          return {
            ...common,
            stage: "wait_correlation",
            outcome: "route",
            target: "resident",
            sessionId: state.wait.owner.id,
            reason: "Inbound message matched an open wait",
            factsUsed: [
              `wait:${state.wait.key}`,
              `wait.action:${action}`,
              `wait.owner:session:${state.wait.owner.id}`,
            ],
          };
        }
        case "pending_ask":
          return {
            ...common,
            stage: "wait_correlation",
            outcome: "route",
            target: "resident",
            sessionId: state.wait.sessionId,
            ...(state.wait.runId === undefined ? {} : { runId: state.wait.runId }),
            reason: "Inbound message matched a pending ask",
            factsUsed: [
              `wait:${state.wait.key}`,
              `wait.session:${state.wait.sessionId}`,
              ...(state.wait.runId === undefined ? [] : [`wait.run:${state.wait.runId}`]),
            ],
          };
        case "pending_interaction": {
          const action = inbound.requestedAction;
          if (action === undefined || !state.wait.allowed.includes(action)) {
            // Fail closed (#548): the legacy store is frozen, so the
            // historical surface fallthrough for a disallowed action is dead
            // code — a matched frozen row blocks exactly like a durable wait,
            // making wait correlation uniformly fail-closed for all backings.
            return {
              ...common,
              stage: "wait_correlation",
              outcome: "block",
              reason: "Matched wait does not allow the requested action",
              factsUsed: [
                `wait:${state.wait.key}`,
                `wait.action:${action ?? "missing"}`,
                "wait.action:disallowed",
              ],
            };
          }
          return {
            ...common,
            stage: "wait_correlation",
            outcome: "route",
            target: `worker-session:${state.wait.sessionId}`,
            sessionId: state.wait.sessionId,
            runId: state.wait.runId,
            pendingInteractionId: state.wait.recordId,
            ...(state.wait.targetActorId === undefined
              ? {}
              : { actorId: state.wait.targetActorId }),
            trustTier: "assigned_worker",
            inboundTreatment: "full_access",
            reason: "Inbound action matched a pending interaction",
            factsUsed: [
              `wait:${state.wait.key}`,
              `wait.action:${action}`,
              `wait.session:${state.wait.sessionId}`,
              `wait.run:${state.wait.runId}`,
            ],
          };
        }
        default:
          return unreachable(state.wait);
      }
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
