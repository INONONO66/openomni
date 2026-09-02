import { beforeEach } from "bun:test";
import type { Gateway, Ingress } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { createGatewayRouter, type GatewayRouter } from "../../src/router/index.js";

/**
 * Actor-resolver test fixture (#707): the pre-flip ingress-engine fixture,
 * re-anchored at the flipped seam. The brain is a deliver-port stub — every
 * admitted event lands as a captured `Gateway.Deliver`, and the resolved
 * actor is asserted where it now rides the seam: `event.meta.actor` on the
 * delivery (the projector audit that used to observe it is brain-side, past
 * the seam). Kept self-contained: its event shapes and seeded grants
 * (discord/guild etc.) differ from the shared router fixture.
 */

/** Every delivery the router handed to the brain stub in the current test. */
export const deliveries: Gateway.Deliver[] = [];

export function setupIngressActorResolverTest(): void {
  beforeEach(() => {
    Storage.reset();
    Bus.reset();
    Storage.initialize({ dbPath: ":memory:" });
    deliveries.length = 0;
    ChannelGrantStore.put({
      id: "grant-discord-guild-dev",
      surface: "discord",
      workspace: "guild",
      channel: "dev",
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "act_owner",
    });
    ChannelGrantStore.put({
      id: "grant-discord-guild-b-dev",
      surface: "discord",
      workspace: "guild-b",
      channel: "dev",
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "act_owner",
    });
    ChannelGrantStore.put({
      id: "grant-telegram-guild-dev",
      surface: "telegram",
      workspace: "guild",
      channel: "dev",
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "act_owner",
    });
  });
}

/**
 * Builds a fresh router instance for the current test with the shared
 * recording deliver stub.
 */
export function getRouter(): GatewayRouter {
  return createGatewayRouter({
    sink: (event, data) => {
      Bus.publish(event, data);
    },
    deliver: async (delivery) => {
      deliveries.push(delivery);
      return {
        mode: "direct",
        target: delivery.event.target ?? { kind: "resident" },
        sessionId: delivery.sessionId ?? "unrouted-session",
        result: { output: "resident response", finishReason: "stop" },
      };
    },
  });
}

export function makeEvent(
  userId: string,
  actor: Ingress.Actor = { role: "user", id: userId },
): Gateway.DeliveredEvent {
  return {
    id: `event-${userId}`,
    traceId: "trace-test",
    surface: "discord",
    workspace: "guild",
    channel: "dev",
    userId,
    mode: "direct",
    payload: "hello",
    meta: { actor },
  };
}

/**
 * The resolved actor as it rode the seam on the LAST captured delivery:
 * `event.meta.actor` after routing treatment (channel default tier, canonical
 * identity). This replaces the retired Bus-observed projector-audit probe —
 * the projection is brain-side since the #707 flip, so actor resolution is
 * asserted on the delivery the router hands across the seam.
 */
export function lastResolvedActor(): Ingress.Actor | undefined {
  const last = deliveries.at(-1);
  // Only external channel deliveries carry a resolved actor; the internal
  // Trigger arm of the union has no perimeter identity to resolve.
  if (last === undefined || last.event.mode !== "direct") return undefined;
  return last.event.meta?.actor;
}

export function registerOwnerEndpoint(workspace?: string): void {
  ActorRegistry.registerIdentity({
    id: "act_owner",
    kind: "human",
    trustTier: "owner",
  });
  ActorRegistry.registerEndpoint({
    id: "ep_discord_user_1",
    actorId: "act_owner",
    channel: "discord",
    externalId: "user-1",
    workspace,
  });
}
