import { beforeEach, describe, expect, test } from "bun:test";
import { extractSurfaceKey, Ingress, type Gateway, type Wait } from "@openomni/protocol";
import { ActorRegistry, BlacklistStore, Storage, SurfaceKey, WaitStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { IngressRoutingError } from "../../src/router/routing-resolution";
import { createExistingAgentMessaging } from "../../src/router/messaging/send";
import { WaitService } from "../../src/router/wait/index";
import { deliveries, kernelRouter, resetRouterState, routingDecisions } from "./_router-fixture";

/**
 * Router half of the kernel wait-routing suite (#707): everything up to the
 * Deliver seam — correlation, decision recording, wait folds
 * (attachReply/expiry), ambiguity, blacklist suppression, and the projected
 * delivery shape.
 */

const correlation = {
  endpointId: "telegram:seller-1",
  channelId: "telegram:dm",
  tokenHash: "token-hash-1",
} satisfies Wait.Correlation;

function replyEvent(
  id: string,
  payload: unknown = { action: "report_result", output: "SN-A2334" },
): Gateway.DeliveredEvent {
  return {
    id,
    traceId: "trace-test",
    surface: "telegram",
    channel: "telegram:dm",
    userId: "seller-1",
    mode: "direct",
    payload,
    meta: { correlation },
  };
}

async function captureError(action: Promise<unknown>): Promise<Error | undefined> {
  try {
    await action;
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
}

describe("GatewayRouter durable wait routing", () => {
  beforeEach(resetRouterState);

  function registerResponder(actorId: string, externalId: string): void {
    ActorRegistry.registerIdentity({
      id: actorId,
      kind: "human",
      trustTier: "assigned_worker",
    });
    ActorRegistry.registerEndpoint({
      id: `telegram:${externalId}`,
      actorId,
      channel: "telegram",
      externalId,
    });
  }

  function openSessionWait(
    id: string,
    overrides: Partial<Parameters<typeof WaitService.open>[0]> = {},
  ) {
    // The owner session id is an opaque label to the router (S1): no session
    // row exists on this side of the seam and none is needed.
    const ownerSessionId = crypto.randomUUID();
    return WaitService.open(
      {
        id,
        ownerRef: { kind: "session", id: ownerSessionId },
        originMessageId: `out-${id}`,
        correlation: { channelId: correlation.channelId, tokenHash: correlation.tokenHash },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-external-worker"],
        resolutionPolicy: "first_reply",
        expiresAt: Number.MAX_SAFE_INTEGER,
        followUpWindow: 60_000,
        ...overrides,
      },
      "trace-test",
    );
  }

  test("attaches a matched reply to the durable wait and delivers it to the owner session", async () => {
    registerResponder("actor-external-worker", "seller-1");
    const wait = openSessionWait("wait-session-owner");
    // A conflicting surface-key mapping must lose to the wait owner's session.
    SurfaceKey.claim(extractSurfaceKey(replyEvent("inbound-wait-reply")), "session-surface-conflict");

    const result = await kernelRouter().ingest(replyEvent("inbound-wait-reply"));

    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "route",
      target: "resident",
      sessionId: wait.ownerRef.id,
      factsUsed: [
        "wait:wait:wait-session-owner",
        "wait.action:report_result",
        `wait.owner:session:${wait.ownerRef.id}`,
      ],
    });
    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(wait.ownerRef.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sessionId).toBe(wait.ownerRef.id);
    expect(deliveries[0]?.waitContext).toEqual({
      waitId: "wait-session-owner",
      allowedAction: "report_result",
    });
    const record = WaitStore.get("wait-session-owner");
    expect(record).toMatchObject({ status: "resolved", partial: false });
    expect(record?.replies).toEqual([
      expect.objectContaining({
        replyKey: "inbound-wait-reply",
        responderId: "actor-external-worker",
      }),
    ]);
  });

  test("keeps a 2-of-3 wait open after the first reply and still delivers to the owner", async () => {
    registerResponder("actor-external-worker", "seller-1");
    const wait = openSessionWait("wait-quorum", {
      expectedResponders: ["actor-external-worker", "actor-b", "actor-c"],
      resolutionPolicy: "quorum",
      quorum: { expected: 3, threshold: 2 },
    });

    const result = await kernelRouter().ingest(replyEvent("inbound-wait-quorum-first"));

    if (result.kind === "dropped") throw new Error("shape");
    expect(result.sessionId).toBe(wait.ownerRef.id);
    const record = WaitStore.get("wait-quorum");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(1);
  });

  test("rejects a duplicate reply key with a typed wait_reply_rejected error", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-duplicate", {
      expectedResponders: ["actor-external-worker", "actor-b"],
      resolutionPolicy: "quorum",
      quorum: { expected: 2, threshold: 2 },
    });

    await kernelRouter().ingest(replyEvent("inbound-wait-duplicate"));
    const error = await captureError(kernelRouter().ingest(replyEvent("inbound-wait-duplicate")));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("wait_reply_rejected");
    expect(error?.message).toBe("wait reply rejected: duplicate_reply");
    // The typed rejection carries the routing decision that produced it.
    expect((error as IngressRoutingError).decision).toMatchObject({
      outcome: "route",
    });
    const record = WaitStore.get("wait-duplicate");
    expect(record?.replies).toHaveLength(1);
  });

  test("lazily expires an open wait on a late reply and returns the typed rejection", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-late-reply", {
      expectedResponders: ["actor-external-worker", "actor-b"],
      resolutionPolicy: "quorum",
      quorum: { expected: 2, threshold: 2 },
      expiresAt: 10_000,
    });
    // An in-deadline reply recorded partial progress before the wait ran out.
    const early = WaitService.attachReply(
      "wait-late-reply",
      {
        replyKey: "reply-early",
        responderCandidates: ["actor-b"],
        at: 1_000,
      },
      "trace-test",
    );
    expect(early.kind).toBe("attached");

    const error = await captureError(kernelRouter().ingest(replyEvent("inbound-wait-late")));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("wait_reply_rejected");
    expect(error?.message).toBe("wait reply rejected: deadline_passed");
    // Lazy expiry folded the wait: expired with the partial progress recorded.
    const record = WaitStore.get("wait-late-reply");
    expect(record).toMatchObject({ status: "expired", partial: true });
    expect(record?.replies).toHaveLength(1);
    expect(deliveries).toHaveLength(0);
  });

  test("redelivers a resolved reply to the owner idempotently without a ledger change", async () => {
    registerResponder("actor-external-worker", "seller-1");
    const wait = openSessionWait("wait-redelivery");

    const first = await kernelRouter().ingest(replyEvent("inbound-wait-redelivery"));
    const resolvedRow = WaitStore.get("wait-redelivery");
    expect(resolvedRow).toMatchObject({ status: "resolved" });
    // Channel redelivery of the SAME reply (e.g. the owner delivery crashed
    // mid-projection): the fold short-circuits to already_resolved and the
    // owner receives the recorded resolution again.
    const second = await kernelRouter().ingest(replyEvent("inbound-wait-redelivery"));

    if (first.kind === "dropped") throw new Error("shape");
    if (second.kind === "dropped") throw new Error("shape");
    expect(first.sessionId).toBe(wait.ownerRef.id);
    expect(second.sessionId).toBe(wait.ownerRef.id);
    expect(deliveries).toHaveLength(2);
    // Ledger row unchanged: same revision, same single reply, no new state.
    expect(WaitStore.get("wait-redelivery")).toEqual(resolvedRow);
  });

  test("rejects a sender outside the expected responders with unknown_responder", async () => {
    registerResponder("actor-external-worker", "seller-1");
    registerResponder("actor-intruder", "intruder-2");
    openSessionWait("wait-intruder", { expectedResponders: ["actor-someone-else"] });

    const intruderEvent = { ...replyEvent("inbound-wait-intruder"), userId: "intruder-2" };
    const error = await captureError(kernelRouter().ingest(intruderEvent));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("wait_reply_rejected");
    expect(error?.message).toBe("wait reply rejected: unknown_responder");
    const record = WaitStore.get("wait-intruder");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(0);

    // Ledger-lie correction (batch ② commit 4): route.decided already recorded
    // outcome:route for this correlated reply, but the fold rejected it
    // fail-closed. The route stream keeps its single route.decided fact…
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    expect(ledger.headFact(Ingress.routeStreamId(intruderEvent))?.type).toBe("route.decided");
    // …and the correcting route.not_delivered fact lands on the separate
    // single-fact route_correction stream, reflecting the non-delivery.
    const correction = ledger.headFact(Ingress.routeCorrectionStreamId(intruderEvent));
    expect(correction?.type).toBe("route.not_delivered");
    expect(correction?.seq).toBe(1);
  });

  test("blocks a disallowed action on a matched durable wait instead of surface routing", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-disallowed-action");

    const error = await captureError(
      kernelRouter().ingest(
        replyEvent("inbound-wait-disallowed", { action: "ask_clarification", question: "Why?" }),
      ),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(error?.message).toBe("Matched wait does not allow the requested action");
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "block",
      factsUsed: [
        "wait:wait:wait-disallowed-action",
        "wait.action:ask_clarification",
        "wait.action:disallowed",
      ],
    });
    // No surface routing happened: nothing was delivered to the brain.
    expect(deliveries).toHaveLength(0);
    const record = WaitStore.get("wait-disallowed-action");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(0);
  });

  test("blocks an explicitly invalid action on a matched durable wait instead of coercing to report_result", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-invalid-action");

    const error = await captureError(
      kernelRouter().ingest(
        replyEvent("inbound-wait-invalid-action", { action: "unknown", output: "SN-A2334" }),
      ),
    );

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(error?.message).toBe("Matched wait does not allow the requested action");
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "block",
      factsUsed: ["wait:wait:wait-invalid-action", "wait.action:invalid", "wait.action:disallowed"],
    });
    expect(deliveries).toHaveLength(0);
    const record = WaitStore.get("wait-invalid-action");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(0);
  });

  test("fails closed for a workItem-owned wait: no ingress delivery path yet", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-work-item", { ownerRef: { kind: "workItem", id: "wi-1" } });

    const error = await captureError(kernelRouter().ingest(replyEvent("inbound-wait-work-item")));

    expect(error).toBeInstanceOf(IngressRoutingError);
    expect((error as IngressRoutingError).code).toBe("route_blocked");
    expect(error?.message).toBe("Matched wait owner has no ingress delivery path");
    expect(routingDecisions()[0]).toMatchObject({
      stage: "wait_correlation",
      outcome: "block",
      factsUsed: [
        "wait:wait:wait-work-item",
        "wait.action:report_result",
        "wait.owner:workItem:wi-1",
        "wait.owner:unsupported_ingress_delivery",
      ],
    });
    const record = WaitStore.get("wait-work-item");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(0);
  });

  test("resolves an awaited 2-of-3 send through router replies from two distinct responder endpoints", async () => {
    // Wired N-of-M proof (#215 Phase E): the awaited message is DELIVERED to
    // a third target actor, while the expected responders answer from their
    // OWN registered endpoints in the same channel, through the full router
    // path (ingressEvidence — no dispatch-phase shortcut).
    registerResponder("actor-r1", "responder-1");
    registerResponder("actor-r2", "responder-2");
    registerResponder("actor-quorum-target", "quorum-target-1");
    const ownerSessionId = crypto.randomUUID();
    const messaging = createExistingAgentMessaging({
      // Concrete-owner shape: the channel API returned a platform message id.
      deliver: () => ({ externalMessageId: "platform-quorum-msg" }),
      grants: () => [
        {
          id: "grant-owner->quorum-target",
          senderId: "actor-owner",
          targetActorId: "actor-quorum-target",
          operations: ["awaited"],
        },
      ],
      publish: Bus.publish,
    });

    const sent = await messaging.send({
      messageId: "out-wired-quorum",
      senderId: "actor-owner",
      target: { actorId: "actor-quorum-target" },
      operation: "awaited",
      body: "reply with your verdict (2-of-3)",
      at: Date.now(),
      traceId: "trace-test",
      waitSpec: {
        waitId: "wait-wired-quorum",
        ownerRef: { kind: "session", id: ownerSessionId },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-r1", "actor-r2", "actor-r3"],
        resolutionPolicy: "quorum",
        quorum: { expected: 3, threshold: 2 },
        expiresAt: Number.MAX_SAFE_INTEGER,
        followUpWindow: 60_000,
        correlation: { channelId: correlation.channelId },
      },
    });
    expect(sent.kind).toBe("sent");
    if (sent.kind !== "sent" || sent.operation !== "awaited") {
      throw new Error("expected awaited sent receipt");
    }
    // Delivery pinned the third target's endpoint; the receipt re-keyed the
    // correlation to the platform message id real replies will reference.
    expect(sent.wait.correlation.endpointId).toBe("telegram:quorum-target-1");
    expect(sent.wait.correlation.replyToMessageId).toBe("platform-quorum-msg");

    const responderReply = (id: string, externalId: string): Gateway.DeliveredEvent => ({
      ...replyEvent(id),
      userId: externalId,
      meta: {
        correlation: {
          endpointId: `telegram:${externalId}`,
          channelId: correlation.channelId,
          replyToMessageId: "platform-quorum-msg",
        },
      },
    });

    const first = await kernelRouter().ingest(responderReply("inbound-wired-r1", "responder-1"));
    const afterFirst = WaitStore.get("wait-wired-quorum");
    expect(afterFirst).toMatchObject({ status: "open" });
    expect(afterFirst?.replies).toHaveLength(1);

    const second = await kernelRouter().ingest(responderReply("inbound-wired-r2", "responder-2"));

    if (first.kind === "dropped") throw new Error("shape");
    if (second.kind === "dropped") throw new Error("shape");
    expect(first.sessionId).toBe(ownerSessionId);
    expect(second.sessionId).toBe(ownerSessionId);
    expect(deliveries).toHaveLength(2);
    const record = WaitStore.get("wait-wired-quorum");
    expect(record).toMatchObject({ status: "resolved", partial: false });
    expect(record?.replies.map((reply) => reply.responderId).sort()).toEqual([
      "actor-r1",
      "actor-r2",
    ]);
  });

  test("blacklist drops a correlated reply before wait delivery and leaves the wait untouched", async () => {
    registerResponder("actor-external-worker", "seller-1");
    openSessionWait("wait-blacklisted");
    BlacklistStore.put({
      id: "blacklist-seller-1",
      kind: "endpoint",
      value: correlation.endpointId,
      createdBy: "actor-owner",
    });

    const result = await kernelRouter().ingest(replyEvent("inbound-blacklisted"));

    expect(result).toMatchObject({ kind: "dropped" });
    expect(routingDecisions()).toHaveLength(1);
    expect(routingDecisions()[0]).toMatchObject({
      stage: "blacklist",
      outcome: "drop",
      factsUsed: [
        "blacklist:blacklist-seller-1",
        "blacklist.kind:endpoint",
        "blacklist.reason:blacklist.endpoint.telegram:seller-1",
      ],
    });
    expect(deliveries).toHaveLength(0);
    const record = WaitStore.get("wait-blacklisted");
    expect(record).toMatchObject({ status: "open" });
    expect(record?.replies).toHaveLength(0);
  });
});
