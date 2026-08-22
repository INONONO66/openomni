import {
  Gateway,
  Ingress,
  Operational,
  Wait,
  extractSurfaceKey,
  newTraceId,
  type BusEvent,
  type Ledger,
  type Policy,
} from "@openomni/protocol";
import { LedgerAppend, SurfaceKey } from "@openomni/ledger";
import { resolveIngressActor } from "./actor-resolver.js";
import { IngressAuthorityMiddleware } from "./authority.js";
import {
  createReplyGrantInstances,
  replyGrantEndpointFromFacts,
  type ReplyGrantAdmission,
  type ReplyGrantInstances,
} from "./messaging/reply-grant.js";
import { createExistingAgentMessaging, type DeliveryReceipt } from "./messaging/send.js";
import type { ExistingAgentMessaging } from "./messaging/send.js";
import {
  executeWaitRoute,
  pinRouteSession,
  pinSelectedTarget,
  requireRoutedDecision,
} from "./routing-execution.js";
import { resolveAndRecordRoute, type KernelRouteResolution } from "./routing-resolution.js";

export { resolveIngressActor } from "./actor-resolver.js";
export { IngressAuthorityMiddleware } from "./authority.js";
export { resolveRoute, type RouteInbound, type RouteState } from "./resolve-route.js";
export {
  executeWaitRoute,
  pinRouteSession,
  pinSelectedTarget,
  requireRoutedDecision,
  type WaitRouteExecution,
} from "./routing-execution.js";
export {
  IngressRoutingError,
  resolveAndRecordRoute,
  type IngressRoutingErrorCode,
  type KernelRouteResolution,
} from "./routing-resolution.js";
export {
  findWaitCandidates,
  targetsOfWait,
  WaitService,
  type WaitResolution,
} from "./wait/index.js";
export { resolveSenderTargetGrant } from "./messaging/grant.js";
export {
  createExistingAgentMessaging,
  type DeliveryReceipt,
  type ExistingAgentMessaging,
  type MessagingPorts,
  type OutboundMessage,
} from "./messaging/send.js";

/**
 * Existing-agent delivery route, keyed by ActorEndpoint channel: the concrete
 * owner behind the messaging kernel's injected-delivery seam (registered by
 * the composition root from its channel adapters).
 */
export type ChannelDeliveryRoute = (externalId: string, body: string) => Promise<DeliveryReceipt>;

/**
 * Construction-time ports of the gateway router (#707 stage 2). ONE entry:
 * the composition root binds the observation sink (Bus.publish), the brain's
 * Deliver consumer, and the outbound delivery owners; the router owns the
 * perimeter store surfaces (direct ledger imports) and every routing
 * judgment. openomni never imports channels and channels never imports
 * openomni — this port set plus the protocol contracts are the whole seam.
 */
export interface GatewayRouterPorts {
  /** Observation sink — route decisions and messaging audit events publish here. */
  readonly sink: BusEvent.Sink["publish"];
  /** The brain's Deliver consumer (gateway → brain, Gateway.Deliver contract). */
  readonly deliver: (delivery: Gateway.Deliver) => Promise<Ingress.IngressResult>;
  /** Observer for routed pre-run authority decisions (never blocks the run). */
  readonly onPolicyDecision?: (decision: Policy.PolicyDecision) => void | Promise<void>;
  /** Outbound send kernel wiring (#215): channel delivery routes + Owner grants. */
  readonly messaging?: Readonly<{
    deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>;
    grants: () => readonly Gateway.SenderTargetGrant[];
    /**
     * Owner-written reply-grant rules (#708, design §2b stage-0 rule): the
     * router materializes bounded, reply-scoped grant INSTANCES from them
     * when it admits a first-contact actor on a covered channel. Instances
     * live in router memory (recorded ruling — durable store is #709).
     */
    replyGrantRules?: () => readonly Gateway.ReplyGrantRule[];
    /**
     * Owner-declared active-egress budgets (#219): the HOW-OFTEN cap on cold
     * proactive outreach, per target actor. When wired, the send kernel's
     * synchronous egress gate engages (fail-safe default: a cold send to a
     * target with no budget entry is suppressed). When absent the gate is
     * bypassed — replies are never throttled either way.
     */
    budgets?: () => readonly Gateway.SocialBudget[];
  }>;
}

export interface GatewayRouter {
  /** External (direct-mode) inbound entry — the channel adapters' routing target. */
  ingest(event: unknown): Promise<Ingress.IngressResult>;
  /** The existing-agent send kernel (#215); fail-closed when unconfigured. */
  readonly messaging: ExistingAgentMessaging;
  /**
   * Gateway port for the brain's INTERNAL-mode surface↔session stickiness
   * claims (#708, closing the #707 residue): the brain injects this at
   * composition instead of writing the perimeter surface directly, making
   * the gateway the literal sole writer of the surface↔session map. CAS
   * semantics: with `expectedSessionId` the claim replaces only that owner;
   * without it, it inserts only when absent. The returned session id is the
   * owner AFTER the attempt — the CAS receipt.
   */
  claimSurface(surfaceKey: string, sessionId: string, expectedSessionId?: string): string;
}

/**
 * Resolves the surface-map session for a resident surface-default delivery.
 * Ruling (#707): the gateway MINTS the sessionId (an opaque label — S1) and
 * claims the map BEFORE deliver (record-before-act); the brain lazily
 * materializes the session row on first Deliver (idempotent
 * create-if-absent). A crash between claim and deliver converges by
 * re-delivery. A lost claim race yields the winner's session id — the map is
 * the single arbiter; no session row is created or removed here (session
 * content is brain domain).
 */
function claimResidentSurfaceSession(surfaceKey: string): string {
  const existing = SurfaceKey.lookup(surfaceKey);
  if (existing !== undefined) return existing;
  const minted = crypto.randomUUID();
  return SurfaceKey.claim(surfaceKey, minted);
}

/**
 * Trust-boundary sanitization at the SINGLE external ingest entry (audit A
 * T2). A channel-driver event may carry only genuinely-inbound perimeter
 * facts (surfaceKey, sender, threadId, replyToId, ...). Gateway-DERIVED fields
 * are minted by the router DURING routing and must never be accepted from the
 * caller, exactly as `meta.actor` is normalized by resolveIngressActor:
 *
 *  - `activation.durableSessionId`: the routed surface/durable session label.
 *    A caller value would otherwise pin ANY session — routing-resolution
 *    reads it as the surface session (surface_default) and session-resolver as
 *    the durable session. Only this field is stripped: the rest of
 *    `activation` (activationId, ...) is in-process routing residue the
 *    projection layer already re-derives or drops, and a legitimate caller
 *    never sets durableSessionId (apps/server ingress/bridge builds none).
 *  - `meta.channelGrantId` / `meta.channelGrantKind` / `meta.pendingAsk`: the
 *    channel-grant treatment + pending-ask projections the router stamps
 *    (authority.applyChannelGrantTreatment / routing-execution). They ride to
 *    authorization + audit reads on the brain side (event-projector,
 *    authority-actor).
 *  - `meta.inboundTreatment`: same class, with ONE carve-out — a caller value
 *    of "evidence_only" is a harmless self-DOWNGRADE (it can only reduce the
 *    sender's own influence, never elevate), preserved so a trusted internal
 *    producer (recovery replay, audit A T1) can re-inject an evidence-only
 *    message. Any other value ("full_access") is an elevation attempt and is
 *    stripped.
 *
 * Verified no legitimate producer sets these: apps/server ingress/bridge
 * `buildInboundEvent` builds meta as { actor, surfaceKey, kind, sender,
 * replyToId, threadId, raw, agentName, correlation } and sets no `activation`.
 */
function sanitizeInboundEvent(event: Gateway.DeliveredEvent): Gateway.DeliveredEvent {
  let next = event;
  if (event.activation?.durableSessionId !== undefined) {
    const { durableSessionId: _durableSessionId, ...restActivation } = event.activation;
    next = { ...next, activation: restActivation };
  }
  if (event.meta !== undefined) {
    const {
      channelGrantId: _channelGrantId,
      channelGrantKind: _channelGrantKind,
      pendingAsk: _pendingAsk,
      inboundTreatment,
      ...keptMeta
    } = event.meta as Ingress.Meta & Record<string, unknown>;
    next = {
      ...next,
      meta: {
        ...keptMeta,
        ...(inboundTreatment === "evidence_only" ? { inboundTreatment } : {}),
      },
    };
  }
  return next;
}

/** The §2a perimeter-verdict projection of a routed delivery. */
function actorContextOf(
  event: Gateway.DeliveredEvent,
  decision: Ingress.RoutingDecisionPayload,
): Gateway.ActorContext | undefined {
  const externalId = event.userId;
  if (
    decision.trustTier === undefined ||
    decision.inboundTreatment === undefined ||
    decision.inboundTreatment === "drop" ||
    externalId === undefined ||
    externalId.length === 0
  ) {
    // Wait/pending resumptions (admission = the correlation itself, asserted
    // via waitContext) and legacy anonymous surfaces carry no tier verdict.
    return undefined;
  }
  return {
    ...(decision.actorId === undefined ? {} : { actorId: decision.actorId }),
    trustTier: decision.trustTier,
    inboundTreatment: decision.inboundTreatment,
    origin: { surface: event.surface, externalId },
  };
}

function buildDelivery(
  event: Gateway.DeliveredEvent,
  decision: Ingress.RoutingDecisionPayload,
  waitContext: Gateway.WaitContext | undefined,
  sessionId: string | undefined,
): Gateway.Deliver {
  const actorContext = actorContextOf(event, decision);
  return Gateway.Deliver.parse({
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(actorContext === undefined ? {} : { actorContext }),
    ...(waitContext === undefined ? {} : { waitContext }),
    event,
    decision,
  } satisfies Gateway.Deliver);
}

function replayReplyGrantAdmissions(): readonly ReplyGrantAdmission[] {
  const ledger = LedgerAppend.port();
  if (
    ledger === undefined ||
    !("factsByType" in ledger) ||
    typeof ledger.factsByType !== "function"
  ) {
    return [];
  }

  const facts = ledger.factsByType(Ingress.ROUTE_DECIDED_FACT_TYPE) as Ledger.RecordedFact[];
  return facts
    .map((fact): ReplyGrantAdmission | undefined => {
      const decision = Ingress.Events.RoutingDecision.schema.parse(fact.data);
      if (decision.outcome !== "route" || decision.actorId === undefined) return undefined;

      const parts = fact.streamId.split(":");
      if (parts.length !== 5 || parts[0] !== "route") return undefined;
      const surface = decodeURIComponent(parts[1] ?? "");
      const workspaceValue = decodeURIComponent(parts[2] ?? "");
      const channelValue = decodeURIComponent(parts[3] ?? "");
      const workspace = workspaceValue === "" ? undefined : workspaceValue;
      const channel = channelValue === "" ? undefined : channelValue;
      if (surface !== decision.surface) return undefined;

      // The concrete endpoint address is part of this immutable decision,
      // captured before the fact was appended. Replay never consults the
      // mutable actor registry; absent or malformed legacy evidence fails closed.
      const endpoint = replyGrantEndpointFromFacts(decision.factsUsed);
      if (endpoint === undefined) return undefined;

      return {
        actorId: decision.actorId,
        endpoint: { channel: endpoint.channel, externalId: endpoint.externalId },
        surface,
        ...(workspace === undefined ? {} : { workspace }),
        ...(channel === undefined ? {} : { channel }),
        traceId: decision.traceId,
        at: decision.time,
        sourceId: fact.streamId,
      };
    })
    .filter((admission): admission is ReplyGrantAdmission => admission !== undefined)
    .sort(
      (left, right) =>
        left.at - right.at || (left.sourceId ?? "").localeCompare(right.sourceId ?? ""),
    );
}

function waitContextOf(resolution: KernelRouteResolution): Gateway.WaitContext | undefined {
  const wait = resolution.waitExecution;
  if (wait.kind !== "wait") return undefined;
  const allowedAction = Wait.AllowedAction.safeParse(wait.requestedAction);
  if (!allowedAction.success) return undefined;
  // #709: engagement resumption context, carried OPAQUELY from the wait row's
  // correlation to the brain (gateway-design §4 id bridge). The router never
  // reads engagement state — matching stayed correlation-only (engagementId
  // is not a CorrelationQuery key), so this can never redirect a delivery.
  const engagementId = wait.record.correlation.engagementId;
  return {
    waitId: wait.record.id,
    allowedAction: allowedAction.data,
    ...(engagementId === undefined ? {} : { engagementId }),
  };
}

export function createGatewayRouter(ports: GatewayRouterPorts): GatewayRouter {
  const replyGrantRules = ports.messaging?.replyGrantRules;
  const replyGrants: ReplyGrantInstances | undefined =
    replyGrantRules === undefined
      ? undefined
      : createReplyGrantInstances({
          rules: replyGrantRules,
          replay: replayReplyGrantAdmissions,
          publish: ports.sink,
        });
  const messagingPorts = ports.messaging;
  const messaging =
    messagingPorts === undefined
      ? undefined
      : createExistingAgentMessaging({
          deliver: async (message) => {
            const route = messagingPorts.deliveryRoutes.get(message.target.channel);
            if (route === undefined) {
              throw new Error(
                `no registered channel surface delivers ${message.target.channel} ` +
                  `(endpoint ${message.target.endpointId}) — delivery fails closed`,
              );
            }
            return route(message.target.externalId, message.body);
          },
          // One grant source per send: Owner-written standing grants plus the
          // live rule-materialized instances. The scope-less base evaluator
          // still refuses the instances; only the scope-aware arm honors one
          // whose replyScope matches the resolved delivery endpoint.
          grants: () => [...messagingPorts.grants(), ...(replyGrants?.list() ?? [])],
          // #219: thread the Owner-declared egress budgets through iff the
          // composition root wired them, so the gate stays a no-op otherwise.
          ...(messagingPorts.budgets === undefined ? {} : { budgets: messagingPorts.budgets }),
          publish: ports.sink,
        });

  return {
    async ingest(input: unknown): Promise<Ingress.IngressResult> {
      const externalEvent = sanitizeInboundEvent(Gateway.DeliveredEvent.parse(input));
      const resolvedActorEvent = resolveIngressActor(externalEvent);
      if (resolvedActorEvent.mode !== "direct") {
        throw new TypeError("external ingress actor resolution changed event mode");
      }
      // D11: inherit the trace minted at the channel's first frame — the
      // router never re-mints.
      const trace = { traceId: externalEvent.traceId };
      const route = resolveAndRecordRoute(resolvedActorEvent, trace.traceId, ports.sink);
      const decision = requireRoutedDecision(route.decision);

      // Reply-grant materialization (#708, §2b stage-0 rule): a ROUTED
      // admission of a resolved, registered actor on a rule-covered channel
      // materializes a bounded reply-scoped grant instance — perimeter facts
      // only (initiator actorId + resolved endpoint + rule TTL). Anonymous
      // senders (no ActorRegistry endpoint) and dropped/blocked events
      // materialize nothing.
      if (replyGrants !== undefined && decision.outcome === "route") {
        const actorId = decision.actorId;
        const endpoint = replyGrantEndpointFromFacts(decision.factsUsed);
        if (actorId !== undefined && endpoint !== undefined) {
          replyGrants.admit({
            actorId,
            endpoint: { channel: endpoint.channel, externalId: endpoint.externalId },
            surface: externalEvent.surface,
            ...(externalEvent.workspace === undefined
              ? {}
              : { workspace: externalEvent.workspace }),
            ...(externalEvent.channel === undefined ? {} : { channel: externalEvent.channel }),
            traceId: trace.traceId,
            at: decision.time,
            sourceId: Ingress.routeStreamId(externalEvent),
          });
        }
      }

      const waitExecution = await executeWaitRoute(trace, route, decision);
      if (waitExecution.kind === "handled") return waitExecution.result;

      if (waitExecution.authority === "pending_interaction") {
        // Dispatch work placement is brain judgment (§8.5): deliver the
        // treated event untouched; the recorded decision carries the routed
        // session/run/pendingInteractionId the brain executes against.
        return ports.deliver(
          buildDelivery(waitExecution.event, route.decision, undefined, decision.sessionId),
        );
      }

      let event = waitExecution.event;
      if (waitExecution.authority === "required") {
        const preRun = await IngressAuthorityMiddleware.runRoutedPreRun({
          event,
          onDecision: ports.onPolicyDecision,
        });
        event = preRun.event;
      }
      const pinned = pinRouteSession(pinSelectedTarget(event, route.selectedTarget), decision);

      // Routed session label: the wait-owner / surface-map pin when the
      // decision carries one; otherwise, for a resident surface-default
      // admission, the router mints + claims the surface map (record-before-
      // act: the route.decided fact above precedes this claim, the claim
      // precedes deliver). Worker-target deliveries stay label-less — work
      // placement is brain judgment.
      let sessionId = pinned.activation?.durableSessionId;
      if (sessionId === undefined && route.selectedTarget.kind === "resident") {
        sessionId = claimResidentSurfaceSession(extractSurfaceKey(pinned));
      }

      return ports.deliver(buildDelivery(pinned, route.decision, waitContextOf(route), sessionId));
    },

    get messaging(): ExistingAgentMessaging {
      if (messaging === undefined) {
        throw new Error("existing-agent messaging is not registered — sends fail closed");
      }
      return messaging;
    },

    // #708 residue closure: internal-mode (cron stickiness) claims cross this
    // port instead of a brain-side SurfaceKey write — the gateway is now the
    // literal sole writer of the surface↔session map. Same CAS semantics as
    // the router's own resident claim above.
    claimSurface(surfaceKey: string, sessionId: string, expectedSessionId?: string): string {
      const ownerSessionId = SurfaceKey.claim(surfaceKey, sessionId, expectedSessionId);
      // audit A T3: every internal stickiness claim crossing this port emits a
      // user-audit-class observation through the injected sink — reusing the
      // Operational log vocabulary (no new frozen descriptor). The receipt is
      // the CAS outcome: the owner AFTER the attempt, and whether this claim
      // won or yielded to a concurrent owner.
      // TODO(#708 residue): the internal surface-key namespace has no scoping
      // scheme yet — when one exists, this claim must be scoped to it and
      // cross-namespace claims rejected here.
      ports.sink(Operational.Events.Info, {
        traceId: newTraceId(),
        time: Date.now(),
        component: "gateway.router",
        msg: "surface stickiness claim",
        context: {
          surfaceKey,
          requestedSessionId: sessionId,
          ...(expectedSessionId === undefined ? {} : { expectedSessionId }),
          ownerSessionId,
          won: ownerSessionId === sessionId,
        },
      });
      return ownerSessionId;
    },
  };
}
