import type { Actor, Conversation, Ingress, Wait } from "@openomni/protocol";
import { effectiveTrustTier } from "./effective-tier.js";

/**
 * External routing arms of THE resolveRoute fold (#707 stage 2). The
 * internal-mode arm (systemActor check + surface-default routing for cron /
 * dispatch events) stayed brain-side as `resolveInternalRoute` — internal
 * mode never crosses the perimeter; this router owns external mode only.
 * Decision strings, stages, and factsUsed are byte-frozen wire vocabulary.
 */
export type RouteInbound = {
  readonly traceId: string;
  readonly time: number;
  readonly id: string;
  readonly surface: string;
  readonly mode: "direct";
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
};

export type RouteState = {
  readonly blacklist?: {
    readonly id: string;
    readonly kind: Actor.BlacklistKind;
    readonly reason?: string;
  };
  readonly wait: RouteWait;
  readonly conversation?: Conversation.Record;
  readonly channel?: RouteChannel;
  readonly actor?: RouteActor;
  readonly surfaceSessionId?: string;
};

type RouteCommon = Readonly<{
  traceId: string;
  time: number;
  inboundId: string;
  surface: string;
  mode: "direct";
}>;

type WaitResolution =
  | Readonly<{ decision: Ingress.RoutingDecisionPayload }>
  | Readonly<{ facts: readonly string[] }>;

function routeCommon(inbound: RouteInbound): RouteCommon {
  return {
    traceId: inbound.traceId,
    time: inbound.time,
    inboundId: inbound.id,
    surface: inbound.surface,
    mode: inbound.mode,
  };
}

function resolveBlacklist(
  common: RouteCommon,
  blacklist: NonNullable<RouteState["blacklist"]>,
): Ingress.RoutingDecisionPayload {
  return {
    ...common,
    stage: "blacklist",
    outcome: "drop",
    reason: "Inbound principal matched the blacklist",
    factsUsed: [
      `blacklist:${blacklist.id}`,
      `blacklist.kind:${blacklist.kind}`,
      ...(blacklist.reason === undefined ? [] : [`blacklist.reason:${blacklist.reason}`]),
    ],
  };
}

function resolveConversation(
  common: RouteCommon,
  conversation: Conversation.Record,
): Ingress.RoutingDecisionPayload {
  // Conversation tier (#P1, docs/conversation-and-message-io.md §3.4): an
  // open window pinned to the sender's endpoint admits the inbound to the
  // window owner's session. Cap breach demotes the treatment to
  // evidence_only (§3.4 onInboundCapBreach:"demote") — the durable
  // increment + one owner wake happen in the store write after this pure
  // fold; the fold only reports the treatment.
  const demoted = conversation.inboundCapBreachedAt !== undefined;
  return {
    ...common,
    stage: "conversation",
    outcome: "route",
    target: "resident",
    sessionId: conversation.ownerRef.id,
    conversationId: conversation.id,
    // The window IS the authority for this delivery — the contact's trust
    // tier is irrelevant inside it, so the treatment the brain consumes is
    // the window's, not the tier ladder's. A cap-breached window demotes
    // to evidence_only (§3.4 onInboundCapBreach:"demote").
    inboundTreatment: demoted ? "evidence_only" : "full_access",
    reason: "Inbound message matched an open conversation",
    factsUsed: [
      `conversation:${conversation.id}`,
      `conversation.owner:session:${conversation.ownerRef.id}`,
      "conversation.authority:window",
      ...(demoted ? ["conversation.cap:breached"] : []),
    ],
  };
}

function resolveWait(inbound: RouteInbound, wait: RouteWait, common: RouteCommon): WaitResolution {
  if (wait.kind === "none") return { facts: ["wait:none"] };
  if (wait.kind === "ambiguous") {
    return {
      decision: {
        ...common,
        stage: "wait_correlation",
        outcome: "ambiguous",
        candidateInteractionIds: [...wait.candidateInteractionIds],
        reason: "Multiple pending waits matched the inbound message",
        factsUsed: wait.candidateInteractionIds.map((id) => `wait.candidate:${id}`),
      },
    };
  }

  const action = inbound.requestedAction;
  if (action === undefined || !wait.allowed.includes(action)) {
    // Fail closed: a matched durable wait never falls through to
    // surface routing — a disallowed action is a typed block, mirroring
    // the owner gate below.
    return {
      decision: {
        ...common,
        stage: "wait_correlation",
        outcome: "block",
        reason: "Matched wait does not allow the requested action",
        factsUsed: [
          `wait:${wait.key}`,
          `wait.action:${action ?? "missing"}`,
          "wait.action:disallowed",
        ],
      },
    };
  }
  if (wait.owner.kind !== "session") {
    // Fail closed: a matched wait must never fall through to surface
    // routing, and workItem-owned resumption has no ingress delivery
    // path yet (#216/#217 wire it).
    return {
      decision: {
        ...common,
        stage: "wait_correlation",
        outcome: "block",
        reason: "Matched wait owner has no ingress delivery path",
        factsUsed: [
          `wait:${wait.key}`,
          `wait.action:${action}`,
          `wait.owner:${wait.owner.kind}:${wait.owner.id}`,
          "wait.owner:unsupported_ingress_delivery",
        ],
      },
    };
  }
  return {
    decision: {
      ...common,
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: wait.owner.id,
      reason: "Inbound message matched an open wait",
      factsUsed: [
        `wait:${wait.key}`,
        `wait.action:${action}`,
        `wait.owner:session:${wait.owner.id}`,
      ],
    },
  };
}

function resolveChannelRoute(
  inbound: RouteInbound,
  state: RouteState,
  common: RouteCommon,
  waitFacts: readonly string[],
): Ingress.RoutingDecisionPayload {
  const channel = state.channel;
  if (channel === undefined) {
    return {
      ...common,
      stage: "channel_ceiling",
      outcome: "block",
      reason: "External inbound message has no channel grant",
      factsUsed: [...waitFacts, "channel:missing"],
    };
  }

  switch (channel.kind) {
    case "blocked_channel":
      return {
        ...common,
        stage: "channel_ceiling",
        outcome: "block",
        inboundTreatment: channel.inboundTreatment,
        reason: "Channel grant blocks inbound messages",
        factsUsed: [
          ...waitFacts,
          `channel:${channel.id}`,
          `channel.kind:${channel.kind}`,
          `channel.treatment:${channel.inboundTreatment}`,
        ],
      };
    case "broadcast_channel":
    case "trusted_channel":
      break;
  }

  const channelFacts = [
    ...waitFacts,
    `channel:${channel.id}`,
    `channel.kind:${channel.kind}`,
    `channel.treatment:${channel.inboundTreatment}`,
  ];
  const actorId = state.actor?.id;
  const trustTier = effectiveTrustTier(state.actor?.trustTier, channel.defaultTier);

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
    inboundTreatment: channel.inboundTreatment,
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

export function resolveRoute(
  inbound: RouteInbound,
  state: RouteState,
): Ingress.RoutingDecisionPayload {
  const common = routeCommon(inbound);
  if (state.blacklist !== undefined) return resolveBlacklist(common, state.blacklist);

  const conversation = state.conversation;
  if (conversation !== undefined && conversation.state === "open") {
    return resolveConversation(common, conversation);
  }

  const waitResolution = resolveWait(inbound, state.wait, common);
  if ("decision" in waitResolution) return waitResolution.decision;

  return resolveChannelRoute(inbound, state, common, waitResolution.facts);
}
