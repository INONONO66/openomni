import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Ingress } from "@openomni/protocol";
import { BlacklistStore, ChannelGrantStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";

import {
  createMappedOwnerSession,
  deliveries,
  kernelRouter,
  ownerEvent,
  registerOwnerDm,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

describe("GatewayRouter kernel routing", () => {
  beforeEach(resetRouterState);

  test("reuses the mapped surface session for a registered Owner DM", async () => {
    // Given
    registerOwnerDm();
    const mappedSession = createMappedOwnerSession();

    // When
    const result = await kernelRouter().ingest(ownerEvent);

    // Then
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(mappedSession.id);
    expect(result.result.output).toBe("resident response");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sessionId).toBe(mappedSession.id);
  });

  test("publishes exactly one route decision for a registered Owner DM", async () => {
    // Given
    registerOwnerDm();
    const mappedSession = createMappedOwnerSession();

    // When
    await kernelRouter().ingest(ownerEvent);

    // Then
    const decisions = routingDecisions();
    expect(decisions).toHaveLength(1);
    expect(Ingress.Events.RoutingDecision.schema.parse(decisions[0])).toMatchObject({
      inboundId: ownerEvent.id,
      stage: "surface_default",
      outcome: "route",
      sessionId: mappedSession.id,
      actorId: "actor-owner",
      trustTier: "owner",
      inboundTreatment: "full_access",
    });
  });

  test("does not deliver when routing decision publication fails", async () => {
    // Given (the fixture sink forwards to Bus.publish — the composition
    // root's binding — so a publish failure aborts the router's ingest)
    registerOwnerDm();
    createMappedOwnerSession();
    const actualPublish = Bus.publish;
    const publish = spyOn(Bus, "publish").mockImplementation((event, data) => {
      if (event === Ingress.Events.RoutingDecision) throw new Error("routing publish failed");
      actualPublish(event, data);
    });

    // When / Then
    try {
      await expect(kernelRouter().ingest(ownerEvent)).rejects.toThrow("routing publish failed");
      expect(deliveries).toHaveLength(0);
    } finally {
      publish.mockRestore();
    }
  });

  test("reads blacklist and channel facts once for one canonical inbound", async () => {
    // Given
    registerOwnerDm();
    createMappedOwnerSession();
    const blacklistRead = spyOn(BlacklistStore, "list");
    const channelRead = spyOn(ChannelGrantStore, "list");
    let blacklistReads = 0;
    let channelReads = 0;

    // When
    try {
      await kernelRouter().ingest(ownerEvent);
      blacklistReads = blacklistRead.mock.calls.length;
      channelReads = channelRead.mock.calls.length;
    } finally {
      blacklistRead.mockRestore();
      channelRead.mockRestore();
    }

    // Then
    expect(blacklistReads).toBe(1);
    expect(channelReads).toBe(1);
  });

  test("mints and claims a surface session when no mapping exists (record-before-act)", async () => {
    // Given
    registerOwnerDm();

    // When
    const result = await kernelRouter().ingest(ownerEvent);

    // Then: the decision recorded "surface.default:new" (no session yet)…
    const decisions = routingDecisions();
    expect(Ingress.Events.RoutingDecision.schema.parse(decisions[0])).toMatchObject({
      stage: "surface_default",
      outcome: "route",
    });
    // …and the delivery carries the freshly claimed opaque label, which the
    // map now owns for the next inbound on the same surface key.
    if (result.kind === "dropped") throw new Error("shape");
    const delivered = deliveries[0]?.sessionId;
    expect(typeof delivered).toBe("string");
    const second = await kernelRouter().ingest({ ...ownerEvent, id: "inbound-owner-dm-2" });
    if (second.kind === "dropped") throw new Error("shape");
    expect(deliveries[1]?.sessionId).toBe(delivered);
  });
});
