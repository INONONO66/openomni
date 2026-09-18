import { afterEach, expect, test } from "bun:test";
import { Gateway } from "@openomni/protocol";
import { ActorRegistry, Storage } from "@openomni/ledger";
import { createExistingAgentMessaging } from "../../../src/router/messaging/send.js";
import { seededRequests } from "../../helpers/requests";

afterEach(() => Storage.reset());

for (const at of [1, 1.5]) {
  test(`send admits a valid Gateway.SendInput whose instant is at=${at}`, async () => {
    Storage.initialize({ dbPath: ":memory:" });
    for (const id of ["sender", "target"]) {
      ActorRegistry.registerIdentity({
        id,
        kind: "ai_agent",
        trustTier: "collaborator",
        createdAt: 0,
        updatedAt: 0,
      });
    }
    ActorRegistry.registerEndpoint({
      id: "endpoint",
      actorId: "target",
      channel: "qa",
      externalId: "target-1",
      createdAt: 0,
      updatedAt: 0,
    });
    const input = Gateway.SendInput.parse({
      messageId: "fractional-send",
      traceId: "fractional",
      senderId: "sender",
      target: { actorId: "target" },
      operation: "fire_and_forget",
      body: "test",
      at,
    });
    const grant = Gateway.SenderTargetGrant.parse({
      id: "grant",
      senderId: "sender",
      targetActorId: "target",
      operations: ["fire_and_forget"],
    });
    let deliveries = 0;
    const messaging = createExistingAgentMessaging({
      requests: seededRequests(),
      grants: () => [grant],
      deliver: () => {
        deliveries += 1;
        return { value: "accepted" as const };
      },
      publish: () => undefined,
    });
    expect(messaging.preflight(input)).toBeUndefined();
    expect((await messaging.send(input)).kind).toBe("sent");
    expect(deliveries).toBe(1);
  });
}
