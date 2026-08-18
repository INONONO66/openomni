import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGatewayRouter, type ChannelDeliveryRoute } from "@openomni/channels";
import type { Gateway } from "@openomni/protocol";
import { ActorRegistry, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import { registerServerMessaging, serverMessaging } from "../../src/bootstrap/messaging";

const now = 5_000_000_000_000;

function registerTarget(channel: string): void {
  ActorRegistry.registerIdentity({
    id: "actor:target",
    kind: "ai_agent",
    trustTier: "collaborator",
    createdAt: now,
    updatedAt: now,
  });
  ActorRegistry.registerEndpoint({
    id: "endpoint:target",
    actorId: "actor:target",
    channel,
    externalId: "target-external-1",
    createdAt: now,
    updatedAt: now,
  });
}

// #707: the send kernel lives in the gateway router — apps/server composes it
// over the channel delivery routes + configured grants and registers the
// router's messaging surface as its fail-closed send seam.
function composeAndRegister(
  deliveryRoutes: ReadonlyMap<string, ChannelDeliveryRoute>,
  grants: readonly Gateway.SenderTargetGrant[],
): void {
  const router = createGatewayRouter({
    sink: Bus.publish,
    deliver: async () => {
      throw new Error("unused");
    },
    messaging: { deliveryRoutes, grants: () => grants },
  });
  registerServerMessaging({
    messaging: router.messaging,
    channels: [...deliveryRoutes.keys()],
    grantsConfigured: grants.length,
    traceId: "trace-test",
  });
}

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("server messaging bootstrap wiring", () => {
  test("grants default empty: a send through the registered seam is denied ungranted", async () => {
    registerTarget("telegram");
    composeAndRegister(new Map(), []);

    const receipt = await serverMessaging().send({
      messageId: "message:unconfigured",
      senderId: "actor:sender",
      target: { actorId: "actor:target" },
      operation: "fire_and_forget",
      body: "should never leave the process",
      at: now,
      traceId: "trace-test",
    });

    expect(receipt.kind).toBe("denied");
    if (receipt.kind !== "denied") throw new Error("expected denial");
    expect(receipt.code).toBe("ungranted");
  });

  test("routes a granted send to the channel delivery route and reports the platform message id", async () => {
    registerTarget("telegram");
    const delivered: Array<{ externalId: string; body: string }> = [];
    const telegramRoute: ChannelDeliveryRoute = async (externalId, body) => {
      delivered.push({ externalId, body });
      return { externalMessageId: "tg:9001" };
    };
    composeAndRegister(new Map([["telegram", telegramRoute]]), [
      {
        id: "grant:sender->target",
        senderId: "actor:sender",
        targetActorId: "actor:target",
        operations: ["awaited"],
      },
    ]);

    const receipt = await serverMessaging().send({
      messageId: "message:awaited",
      senderId: "actor:sender",
      target: { actorId: "actor:target" },
      operation: "awaited",
      body: "please confirm",
      at: now,
      traceId: "trace-test",
      waitSpec: {
        waitId: "wait:server-awaited",
        ownerRef: { kind: "session", id: "session:owner" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor:target"],
        resolutionPolicy: "first_reply",
        expiresAt: now + 600_000,
        followUpWindow: 30_000,
      },
    });

    expect(delivered).toEqual([{ externalId: "target-external-1", body: "please confirm" }]);
    expect(receipt.kind).toBe("sent");
    if (receipt.kind !== "sent" || receipt.operation !== "awaited") {
      throw new Error("expected awaited sent receipt");
    }
    // The channel's platform message id re-keyed the wait correlation.
    expect(receipt.wait.correlation.replyToMessageId).toBe("tg:9001");
  });

  test("a resolved endpoint on a channel without a registered route fails closed", async () => {
    registerTarget("github");
    composeAndRegister(new Map(), [
      {
        id: "grant:sender->target",
        senderId: "actor:sender",
        targetActorId: "actor:target",
        operations: ["fire_and_forget"],
      },
    ]);

    await expect(
      serverMessaging().send({
        messageId: "message:unroutable",
        senderId: "actor:sender",
        target: { actorId: "actor:target" },
        operation: "fire_and_forget",
        body: "no surface delivers this channel",
        at: now,
        traceId: "trace-test",
      }),
    ).rejects.toThrow("no registered channel surface delivers github");
  });

  test("registration publishes the delivery-owner receipt with channels and grant count", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    Bus.observe((event, payload) => {
      if (event.name === "operational.info") {
        payloads.push(payload as Record<string, unknown>);
      }
    });

    composeAndRegister(new Map([["telegram", async () => ({ externalMessageId: "tg:1" })]]), []);
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

    const receipt = payloads.find(
      (payload) => payload.msg === "existing-agent messaging delivery owner registered",
    );
    expect(receipt).toBeDefined();
    expect(receipt?.context).toEqual({ channels: ["telegram"], grantsConfigured: 0 });
  });
});
