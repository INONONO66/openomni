import { beforeEach, describe, expect, test } from "bun:test";
import { extractSurfaceKey, extractText, Ingress } from "@openomni/protocol";
import { ActorRegistry, WaitStore } from "@openomni/ledger";
import {
  createMappedOwnerSession,
  deliveries,
  kernelRouter,
  ownerEvent,
  registerOwnerDm,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

/**
 * Deliver-contract projection invariant (#707 review NIT): the §2a verdict
 * fields (message / actorContext / waitContext / sessionId) are DERIVED
 * from the same recorded decision + routed event the brain executes via
 * `event` + `decision`. This suite pins the two representations to each
 * other so they cannot silently diverge — an actorContext that disagrees
 * with its decision would be a forged perimeter verdict.
 */
describe("Gateway.Deliver projection ≡ decision invariant", () => {
  beforeEach(resetRouterState);

  test("a surface-default admission projects actorContext and message from the recorded decision", async () => {
    registerOwnerDm();
    const mapped = createMappedOwnerSession();

    await kernelRouter().ingest(ownerEvent);

    const delivery = deliveries[0];
    if (delivery === undefined) throw new Error("expected a delivery");
    const decision = Ingress.Events.RoutingDecision.schema.parse(routingDecisions()[0]);
    // The delivery carries the decision verbatim…
    expect(delivery.decision).toEqual(decision);
    // …and every §2a verdict field is that decision's projection.
    if (
      decision.trustTier === undefined ||
      decision.inboundTreatment === undefined ||
      decision.inboundTreatment === "drop"
    ) {
      throw new Error("expected a routed tier verdict on the surface-default decision");
    }
    expect(delivery.actorContext).toEqual({
      ...(decision.actorId === undefined ? {} : { actorId: decision.actorId }),
      trustTier: decision.trustTier,
      inboundTreatment: decision.inboundTreatment,
      origin: { surface: delivery.event.surface, externalId: delivery.event.userId ?? "" },
    });
    expect(decision.trustTier).toBe("owner");
    expect(decision.inboundTreatment).toBe("full_access");
    // The message block is the event's projection — same identity, same text.
    expect(delivery.message).toEqual({
      messageId: delivery.event.id,
      traceId: delivery.event.traceId,
      surfaceKey: extractSurfaceKey(delivery.event),
      text: extractText(delivery.event.payload),
    });
    // The routed label is the decision's session.
    expect(delivery.sessionId).toBe(mapped.id);
    expect(decision.sessionId).toBe(mapped.id);
    expect(delivery.waitContext).toBeUndefined();
  });

  test("a wait resumption projects waitContext from the decision facts and carries no tier verdict", async () => {
    ActorRegistry.registerIdentity({
      id: "actor-owner-responder",
      kind: "human",
      trustTier: "owner",
    });
    ActorRegistry.registerEndpoint({
      id: "endpoint-owner-responder",
      actorId: "actor-owner-responder",
      channel: ownerEvent.surface,
      externalId: ownerEvent.userId,
      workspace: ownerEvent.workspace,
    });
    const ownerSessionId = crypto.randomUUID();
    WaitStore.create(
      {
        id: "wait-contract",
        ownerRef: { kind: "session", id: ownerSessionId },
        originMessageId: "out-wait-contract",
        correlation: { channelId: "chan-contract", tokenHash: "token-contract" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-owner-responder"],
        resolutionPolicy: "first_reply",
        expiresAt: Number.MAX_SAFE_INTEGER,
        followUpWindow: 60_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      "trace-test",
    );

    await kernelRouter().ingest({
      ...ownerEvent,
      id: "inbound-wait-contract",
      payload: { action: "report_result", output: "done" },
      meta: {
        correlation: {
          endpointId: "endpoint-owner-responder",
          channelId: "chan-contract",
          tokenHash: "token-contract",
        },
      },
    });

    const delivery = deliveries[0];
    if (delivery === undefined) throw new Error("expected a delivery");
    const decision = Ingress.Events.RoutingDecision.schema.parse(routingDecisions()[0]);
    expect(delivery.decision).toEqual(decision);
    expect(decision.stage).toBe("wait_correlation");
    // waitContext ≡ the decision's wait facts.
    expect(decision.factsUsed).toContain("wait:wait:wait-contract");
    expect(decision.factsUsed).toContain("wait.action:report_result");
    expect(delivery.waitContext).toEqual({
      waitId: "wait-contract",
      allowedAction: "report_result",
    });
    // Resumption admission is the correlation itself — no tier verdict, so
    // no actorContext (a projected one would be a forged verdict).
    expect(decision.trustTier).toBeUndefined();
    expect(delivery.actorContext).toBeUndefined();
    // The routed label is the wait owner's session, exactly as decided.
    expect(decision.sessionId).toBe(ownerSessionId);
    expect(delivery.sessionId).toBe(ownerSessionId);
    expect(delivery.event.activation?.durableSessionId).toBe(ownerSessionId);
  });
});
