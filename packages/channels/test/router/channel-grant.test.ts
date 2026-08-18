import { describe, expect, it } from "bun:test";
import { ChannelGrantStore } from "@openomni/ledger";
import {
  deliveries,
  getRouter,
  makeEvent,
  registerOwnerEndpoint,
  setupIngressActorResolverTest,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

describe("Ingress channel grants", () => {
  it("blocks inbound events when no channel grant matches", async () => {
    ChannelGrantStore.remove("grant-discord-guild-dev");
    registerOwnerEndpoint("guild");
    const router = getRouter();

    let caughtError: Error | undefined;
    try {
      await router.ingest(makeEvent("user-1"));
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      caughtError = err;
    }

    expect(caughtError?.message).toContain("channel_grant.missing");
    expect(deliveries).toHaveLength(0);
  });

  it("drops blocked channels before resident execution", async () => {
    ChannelGrantStore.put({
      id: "grant-discord-guild-dev",
      surface: "discord",
      workspace: "guild",
      channel: "dev",
      kind: "blocked_channel",
      createdBy: "act_owner",
    });
    registerOwnerEndpoint("guild");
    const router = getRouter();

    let caughtError: Error | undefined;
    try {
      await router.ingest(makeEvent("user-1"));
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      caughtError = err;
    }

    expect(caughtError?.message).toContain("channel_grant.blocked_channel.drop");
    expect(deliveries).toHaveLength(0);
  });

  it("allows broadcast channels as evidence-only inbound treatment", async () => {
    ChannelGrantStore.put({
      id: "grant-discord-guild-dev",
      surface: "discord",
      workspace: "guild",
      channel: "dev",
      kind: "broadcast_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
    });
    const router = getRouter();

    const result = await router.ingest(makeEvent("unknown-user"));

    expect(result.mode).toBe("direct");
    expect(deliveries).toHaveLength(1);
    // The treated event rides the delivery (the projection audit that used to
    // observe inboundTreatment is brain-side, past the seam).
    expect(deliveries[0]?.event.meta?.inboundTreatment).toBe("evidence_only");
  });
});
