import { describe, expect, it } from "bun:test";
import { ActorRegistry, BlacklistStore, ChannelGrantStore } from "@openomni/ledger";
import {
  deliveries,
  getRouter,
  lastResolvedActor,
  makeEvent,
  setupIngressActorResolverTest,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

function putMintGrant(max = 2): void {
  ChannelGrantStore.put({
    id: "grant-whatsapp-mint",
    surface: "whatsapp",
    workspace: "guild",
    channel: "dev",
    kind: "trusted_channel",
    defaultTier: "observer",
    provisionalMint: { windowMs: 600_000, max },
    createdBy: "act_owner",
  });
}

function whatsappEvent(userId: string) {
  return { ...makeEvent(userId), surface: "whatsapp" };
}

describe("provisional contact mint (#P3 §3.1/§8.12)", () => {
  it("mints a provisional contact for an unknown sender on an opted-in trusted channel", async () => {
    putMintGrant();
    const router = getRouter();

    await router.ingest(whatsappEvent("stranger-1"));

    const actor = lastResolvedActor();
    expect(actor).toMatchObject({
      actorId: "contact:whatsapp:guild:stranger-1",
      kind: "unknown",
      trustTier: "observer",
      standing: "provisional",
      endpointId: "ep:whatsapp:guild:stranger-1",
    });
    // Evidence, never authority: the delivered treatment is demoted.
    expect(deliveries.at(-1)?.event.meta?.inboundTreatment).toBe("evidence_only");
    expect(
      ActorRegistry.resolveEndpoint("whatsapp", "stranger-1", "guild")?.identity.standing,
    ).toBe("provisional");
  });

  it("resolves the SAME contact on redelivery — no second mint", async () => {
    putMintGrant();
    const router = getRouter();

    await router.ingest(whatsappEvent("stranger-1"));
    await router.ingest({ ...whatsappEvent("stranger-1"), id: "event-second" });

    expect(lastResolvedActor()?.actorId).toBe("contact:whatsapp:guild:stranger-1");
    expect(ActorRegistry.countProvisionalMints("whatsapp", "guild", 0)).toBe(1);
  });

  it("never mints without an Owner-declared mint policy (zero-default)", async () => {
    // The fixture's discord grant carries no provisionalMint.
    const router = getRouter();

    await router.ingest(makeEvent("stranger-2"));

    expect(lastResolvedActor()).toEqual({ role: "user", id: "stranger-2", trustTier: "owner" });
    expect(ActorRegistry.countProvisionalMints("discord", "guild", 0)).toBe(0);
  });

  it("stops minting at the per-channel window bound (§8.12 flood hold)", async () => {
    putMintGrant(1);
    const router = getRouter();

    await router.ingest(whatsappEvent("stranger-1"));
    // Past the bound the sender stays unknown — downstream authority refuses
    // the observer-tier unknown instead of minting a contact for it.
    await expect(router.ingest(whatsappEvent("stranger-2"))).rejects.toThrow(
      /not authorized to create top-level inbound work/,
    );

    expect(ActorRegistry.countProvisionalMints("whatsapp", "guild", 0)).toBe(1);
  });

  it("never mints for a blacklisted channel address", async () => {
    putMintGrant();
    BlacklistStore.put({
      id: "bl-whatsapp",
      kind: "channel",
      value: "whatsapp",
      createdBy: "act_owner",
    });
    const router = getRouter();

    await router.ingest(whatsappEvent("stranger-1"));

    expect(ActorRegistry.countProvisionalMints("whatsapp", "guild", 0)).toBe(0);
  });

  it("never mints on a broadcast channel even with a policy present", async () => {
    ChannelGrantStore.put({
      id: "grant-broadcast-mint",
      surface: "whatsapp",
      workspace: "guild",
      channel: "dev",
      kind: "broadcast_channel",
      defaultTier: "observer",
      provisionalMint: { windowMs: 600_000, max: 2 },
      createdBy: "act_owner",
    });
    const router = getRouter();

    await router.ingest(whatsappEvent("stranger-1"));

    expect(ActorRegistry.countProvisionalMints("whatsapp", "guild", 0)).toBe(0);
  });
});
