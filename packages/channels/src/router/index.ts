import {
  Gateway,
  type Ingress,
  Wait,
  extractSurfaceKey,
  extractText,
  type BusEvent,
  type Policy,
} from "@openomni/protocol";
import { SurfaceKey } from "@openomni/ledger";
import { resolveIngressActor } from "./actor-resolver.js";
import { IngressAuthorityMiddleware } from "./authority.js";
import { createReplyGrantInstances, type ReplyGrantInstances } from "./messaging/reply-grant.js";
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
export { Events as MessagingAuditEvents } from "./messaging/events.js";
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

function stringMeta(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
  const message: Gateway.InboundMessage = {
    messageId: event.id,
    traceId: event.traceId,
    surfaceKey: stringMeta(event.meta?.surfaceKey) ?? extractSurfaceKey(event),
    text: extractText(event.payload),
    ...(stringMeta(event.meta?.threadId) === undefined
      ? {}
      : { threadId: stringMeta(event.meta?.threadId) }),
    ...(stringMeta(event.meta?.replyToId) === undefined
      ? {}
      : { replyToId: stringMeta(event.meta?.replyToId) }),
  };
  const actorContext = actorContextOf(event, decision);
  return Gateway.Deliver.parse({
    ...(sessionId === undefined ? {} : { sessionId }),
    message,
    ...(actorContext === undefined ? {} : { actorContext }),
    ...(waitContext === undefined ? {} : { waitContext }),
    event,
    decision,
  } satisfies Gateway.Deliver);
}

function waitContextOf(resolution: KernelRouteResolution): Gateway.WaitContext | undefined {
  const wait = resolution.waitExecution;
  if (wait.kind !== "wait") return undefined;
  const allowedAction = Wait.AllowedAction.safeParse(wait.requestedAction);
  if (!allowedAction.success) return undefined;
  return { waitId: wait.record.id, allowedAction: allowedAction.data };
}

export function createGatewayRouter(ports: GatewayRouterPorts): GatewayRouter {
  const replyGrantRules = ports.messaging?.replyGrantRules;
  const replyGrants: ReplyGrantInstances | undefined =
    replyGrantRules === undefined
      ? undefined
      : createReplyGrantInstances({ rules: replyGrantRules, publish: ports.sink });
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
          publish: ports.sink,
        });

  return {
    async ingest(input: unknown): Promise<Ingress.IngressResult> {
      const externalEvent = Gateway.DeliveredEvent.parse(input);
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
        const actor = resolvedActorEvent.meta?.actor;
        const actorId = typeof actor?.actorId === "string" ? actor.actorId : undefined;
        const endpoint = actor?.endpoint;
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
            at: Date.now(),
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
      return SurfaceKey.claim(surfaceKey, sessionId, expectedSessionId);
    },
  };
}
