import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ActorRegistry, Bus, Storage } from "@openomni/session";
import { registerServerMessaging, serverMessaging } from "../../src/bootstrap/messaging";
import type { ChannelDeliveryRoute } from "../../src/bootstrap/messaging";

const now = 5_000_000_000_000;

function registerTarget(channel: string): void {
  ActorRegistry.registerIdentity({
    id: "actor:target",
    kind: "ai_agent",
    trustTier: "collaborator",
    relationship: "collaborator",
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
    registerServerMessaging({ deliveryRoutes: new Map(), grants: [], traceId: "trace-test" });

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
    registerServerMessaging({
      traceId: "trace-test",
      deliveryRoutes: new Map([["telegram", telegramRoute]]),
      grants: [
        {
          id: "grant:sender->target",
          senderId: "actor:sender",
          targetActorId: "actor:target",
          operations: ["awaited"],
        },
      ],
    });

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
    registerServerMessaging({
      traceId: "trace-test",
      deliveryRoutes: new Map(),
      grants: [
        {
          id: "grant:sender->target",
          senderId: "actor:sender",
          targetActorId: "actor:target",
          operations: ["fire_and_forget"],
        },
      ],
    });

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
});
