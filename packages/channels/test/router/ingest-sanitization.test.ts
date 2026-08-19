import { describe, expect, it } from "bun:test";
import { Bus } from "@openomni/telemetry";
import type { Gateway } from "@openomni/protocol";
import {
  deliveries,
  getRouter,
  makeEvent,
  setupIngressActorResolverTest,
} from "./_actor-resolver-fixture";

setupIngressActorResolverTest();

function lastDelivery(): Gateway.Deliver {
  const delivery = deliveries.at(-1);
  if (!delivery) throw new Error("no delivery captured");
  return delivery;
}

// discord/guild/dev is seeded as a trusted_channel (defaultTier owner ⇒
// full_access) by the shared fixture.
describe("ingest trust-boundary sanitization (audit A T2)", () => {
  it("strips a caller-supplied activation.durableSessionId (never pins a session)", async () => {
    const router = getRouter();

    await router.ingest({
      ...makeEvent("user-1"),
      activation: { durableSessionId: "attacker-pinned-session" },
    });

    const delivery = lastDelivery();
    expect(delivery.sessionId).not.toBe("attacker-pinned-session");
    expect(delivery.event.activation?.durableSessionId).not.toBe("attacker-pinned-session");
  });

  it("strips caller-supplied reserved trust meta keys (channelGrant*, pendingAsk)", async () => {
    const router = getRouter();

    await router.ingest({
      ...makeEvent("user-1"),
      meta: {
        actor: { role: "user", id: "user-1" },
        channelGrantId: "spoof-grant",
        channelGrantKind: "trusted_channel",
        pendingAsk: { id: "spoof-ask", status: "open" },
      },
    });

    const delivery = lastDelivery();
    // A surface-default route never sets pendingAsk → its absence proves the strip.
    expect(delivery.event.meta?.pendingAsk).toBeUndefined();
    // channelGrantId reflects the REAL resolved grant, not the caller's spoof.
    expect(delivery.event.meta?.channelGrantId).not.toBe("spoof-grant");
  });

  it("preserves a caller inboundTreatment of evidence_only and floors channel treatment (T1)", async () => {
    const router = getRouter();

    await router.ingest({
      ...makeEvent("user-1"),
      meta: { actor: { role: "user", id: "user-1" }, inboundTreatment: "evidence_only" },
    });

    const delivery = lastDelivery();
    // A full_access trusted channel is floored to evidence_only by the marker.
    expect(delivery.decision.inboundTreatment).toBe("evidence_only");
    expect(delivery.actorContext?.inboundTreatment).toBe("evidence_only");
  });

  it("does NOT downgrade a full_access channel without the marker (control)", async () => {
    const router = getRouter();

    await router.ingest(makeEvent("user-1"));

    const delivery = lastDelivery();
    expect(delivery.decision.inboundTreatment).toBe("full_access");
    expect(delivery.actorContext?.inboundTreatment).toBe("full_access");
  });
});

describe("claimSurface observation (audit A T3)", () => {
  it("publishes a user-audit observation carrying the CAS receipt per claim", async () => {
    const router = getRouter();
    const observed: Array<{ name: string; payload: Record<string, unknown> }> = [];
    Bus.observe((event, payload) =>
      observed.push({ name: event.name, payload: payload as Record<string, unknown> }),
    );

    const owner = router.claimSurface("telegram:bot:chat:1", "sess-a");
    // Bus observers fire on a microtask — flush before asserting.
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    expect(owner).toBe("sess-a");
    const obs = observed.find(
      (e) => e.name === "operational.info" && String(e.payload.msg) === "surface stickiness claim",
    );
    expect(obs).toBeDefined();
    expect(obs?.payload.context).toMatchObject({
      surfaceKey: "telegram:bot:chat:1",
      requestedSessionId: "sess-a",
      ownerSessionId: "sess-a",
      won: true,
    });
  });
});
