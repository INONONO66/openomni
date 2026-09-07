import { beforeEach } from "bun:test";
import type { Gateway, Ingress } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore } from "@openomni/ledger";
import { resetStores } from "./_router-fixture";

export function setupIngressActorResolverTest(): void {
  beforeEach(() => {
    resetStores();
    for (const [surface, workspace] of [
      ["discord", "guild"],
      ["discord", "guild-b"],
      ["telegram", "guild"],
    ] as const) {
      ChannelGrantStore.put({
        id: `grant-${surface}-${workspace}`,
        surface,
        workspace,
        channel: "dev",
        kind: "trusted_channel",
        defaultTier: "owner",
        createdBy: "act_owner",
      });
    }
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

export function registerOwnerEndpoint(workspace?: string): void {
  ActorRegistry.registerIdentity({ id: "act_owner", kind: "human", trustTier: "owner" });
  ActorRegistry.registerEndpoint({
    id: "ep_discord_user_1",
    actorId: "act_owner",
    channel: "discord",
    externalId: "user-1",
    workspace,
  });
}
