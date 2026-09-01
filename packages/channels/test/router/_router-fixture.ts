import { extractSurfaceKey, type Gateway, type Ingress } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Storage, SurfaceKey } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import {
  createGatewayRouter,
  type GatewayRouter,
  type GatewayRouterPorts,
} from "../../src/router/index.js";

/**
 * Gateway-router test fixture (#707): the pre-flip kernel-routing fixture,
 * re-anchored at the flipped seam. The brain is a deliver-port stub — a
 * captured `Gateway.Deliver` is the router's whole output for an admitted
 * event, and the canned "resident response" stands in for the brain's run.
 * The sink forwards to the real Bus (the composition root's binding) while
 * also collecting locally, so decision assertions never race observers.
 */

export const ownerEvent = {
  id: "inbound-owner-dm",
  traceId: "trace-test",
  surface: "discord",
  workspace: "owner-workspace",
  channel: "owner-dm",
  userId: "owner-external-id",
  mode: "direct",
  payload: "hello resident",
  meta: { actor: { role: "user" } },
} satisfies Gateway.DeliveredEvent;

/**
 * Minimal inbound delivered-event builder for router tests. The three router
 * suites (policy-deny-wins, middleware-integration, authority-validation) each
 * carried a byte-identical copy; this is the one home.
 */
export function makeInboundEvent(
  overrides?: Partial<Gateway.DeliveredEvent>,
): Gateway.DeliveredEvent {
  return {
    id: "evt-1",
    traceId: "trace-test",
    surface: "test",
    mode: "direct",
    ...overrides,
  } as Gateway.DeliveredEvent;
}

/** Every delivery the router handed to the brain stub in the current test. */
export const deliveries: Gateway.Deliver[] = [];

/** Every event published through the injected sink in the current test. */
const sinkEvents: Array<{ readonly name: string; readonly data: unknown }> = [];

let router: GatewayRouter | undefined;

/**
 * The store half of the fixture, without the router: fresh in-memory Storage
 * and Bus. Router-less kernel suites (messaging send kernel, WaitService)
 * duplicated this trio inline; this is the one home.
 */
export function resetStores(): void {
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:" });
}

export function resetRouterState(): void {
  resetStores();
  deliveries.length = 0;
  sinkEvents.length = 0;
  router = makeRouter();
}

/** The router created for the current test by resetRouterState(). */
export function kernelRouter(): GatewayRouter {
  if (!router) throw new Error("resetRouterState() must run before kernelRouter()");
  return router;
}

function stubDeliverResult(delivery: Gateway.Deliver): Ingress.IngressResult {
  return {
    mode: "direct",
    target: delivery.event.target ?? { kind: "resident" },
    sessionId: delivery.sessionId ?? "unrouted-session",
    result: { output: "resident response", finishReason: "stop" },
  };
}

/**
 * Rebuilds the current test's router with overridden ports (#549 discipline:
 * construction-time injection only), keeping the shared recording stubs.
 */
export function makeRouter(overrides: Partial<GatewayRouterPorts> = {}): GatewayRouter {
  router = createGatewayRouter({
    sink: (event, data) => {
      sinkEvents.push({ name: event.name, data });
      Bus.publish(event, data);
    },
    deliver: async (delivery) => {
      deliveries.push(delivery);
      return stubDeliverResult(delivery);
    },
    ...overrides,
  });
  return router;
}

export function registerOwnerDm(): void {
  ActorRegistry.registerIdentity({
    id: "actor-owner",
    kind: "human",
    trustTier: "owner",
  });
  ActorRegistry.registerEndpoint({
    id: "endpoint-owner-dm",
    actorId: "actor-owner",
    channel: ownerEvent.surface,
    externalId: ownerEvent.userId,
    workspace: ownerEvent.workspace,
  });
  ChannelGrantStore.put({
    id: "grant-owner-dm",
    surface: ownerEvent.surface,
    workspace: ownerEvent.workspace,
    channel: ownerEvent.channel,
    kind: "trusted_channel",
    createdBy: "actor-owner",
  });
}

/**
 * Claims the owner DM's surface key for a fabricated session id. The router
 * treats the mapped id as an opaque label (S1) — no session row exists and
 * none is needed on the perimeter side of the seam.
 */
export function createMappedOwnerSession(): { readonly id: string } {
  const id = crypto.randomUUID();
  SurfaceKey.claim(extractSurfaceKey(ownerEvent), id);
  return { id };
}

export function routingDecisions(): readonly unknown[] {
  return sinkEvents
    .filter((event) => event.name === "ingress.routing.decision")
    .map((event) => event.data);
}

export function allSinkEvents(): readonly Array<{ readonly name: string; readonly data: unknown }> {
  return sinkEvents;
}

export function grantMatEvents(): readonly Array<{ readonly instanceId: string; readonly targetActorId: string }> {
  return sinkEvents
    .filter((event) => event.name === "operational.info")
    .filter((event) => {
      const data = event.data as { readonly msg?: string; readonly context?: unknown };
      return data.msg === "reply-grant instance materialized";
    })
    .map((event) => {
      const data = event.data as { readonly context?: { readonly instanceId?: string; readonly targetActorId?: string } };
      return {
        instanceId: data.context?.instanceId ?? "",
        targetActorId: data.context?.targetActorId ?? "",
      };
    });
}
