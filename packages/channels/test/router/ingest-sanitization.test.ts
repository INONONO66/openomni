import { describe, expect, it } from "bun:test";
import type { Gateway, Ingress } from "@openomni/protocol";
import { createGatewayRouter } from "../../src/router/index.js";
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

  it("strips caller-supplied reserved trust meta keys (channelGrant*)", async () => {
    const router = getRouter();

    await router.ingest({
      ...makeEvent("user-1"),
      meta: {
        actor: { role: "user", id: "user-1" },
        channelGrantId: "spoof-grant",
        channelGrantKind: "trusted_channel",
      },
    });

    const delivery = lastDelivery();
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

describe("surface stickiness claim observations (audit A T3)", () => {
  it("publishes the CAS receipt through the injected sink for an external resident default", async () => {
    const observed: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const router = createGatewayRouter({
      sink: (event, payload) =>
        observed.push({ name: event.name, payload: payload as Record<string, unknown> }),
      deliver: async (delivery): Promise<Ingress.IngressResult> => ({
        mode: "direct",
        target: delivery.event.target ?? { kind: "resident" },
        sessionId: delivery.sessionId ?? "unrouted-session",
        result: { output: "resident response", finishReason: "stop" },
      }),
    });

    await router.ingest(makeEvent("user-1"));

    const obs = observed.find(
      (event) =>
        event.name === "operational.info" &&
        String(event.payload.msg) === "surface stickiness claim",
    );
    expect(obs?.payload.context).toMatchObject({
      mode: "external_resident_default",
      surfaceKey: "discord:guild:dev",
      ownerSessionId: expect.any(String),
      requestedSessionId: expect.any(String),
      won: true,
    });
  });
});
