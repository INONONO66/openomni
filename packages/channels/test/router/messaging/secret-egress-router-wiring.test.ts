import { beforeEach, describe, expect, test } from "bun:test";
import type { Gateway, Ingress } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { createGatewayRouter } from "../../../src/router/index.js";
import { buildGrant, messagingNow, registerAgentFixture } from "../../helpers/messaging.js";
import { resetStores } from "../_router-fixture";

/**
 * #811 wiring: the router owns the ONE place the egress gate lives, so it is
 * the router that hands the channel renderer to the send kernel. A router
 * built without `renderFor` still gates on the raw body — the renderer only
 * widens what the same single gate sees.
 */

let delivered: string[];

function router(renderFor?: (channel: string) => ((markdown: string) => string) | undefined) {
  delivered = [];
  return createGatewayRouter({
    sink: Bus.publish,
    deliver: (): Promise<Ingress.IngressResult> => {
      throw new Error("inbound deliver is not exercised by this suite");
    },
    ...(renderFor === undefined ? {} : { renderFor }),
    messaging: {
      deliveryRoutes: new Map([
        [
          "qa",
          async (_externalId: string, body: string) => {
            delivered.push(body);
            return {};
          },
        ],
      ]),
      grants: () => [buildGrant("grant:sender->target")],
    },
  });
}

function sendInput(body: string): Gateway.SendInput {
  return {
    messageId: `message:${body.length}-${body.slice(0, 8)}`,
    senderId: "actor:sender",
    target: { actorId: "actor:target" },
    operation: "fire_and_forget",
    body,
    at: messagingNow,
    traceId: "trace-router-wiring",
  };
}

beforeEach(() => {
  resetStores();
  registerAgentFixture("actor:sender");
  registerAgentFixture("actor:target", [{ id: "endpoint:target", externalId: "target-1" }]);
});

describe("router-owned egress gate wiring", () => {
  test("Given no renderFor port, When a credential body is sent through the router, Then it is denied", async () => {
    const receipt = await router().messaging.send(
      sendInput("deploy key ghp_Ab3dEf9hIjKlMn0pQrStUvWxYz0123456789"),
    );

    expect(receipt).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expect(delivered).toEqual([]);
  });

  test("Given a renderFor port that reveals a credential, When sent, Then the router-threaded renderer gates it", async () => {
    const receipt = await router((channel) =>
      channel === "qa"
        ? (markdown) => markdown.replace("REDACTED", "AKIAIOSFODNN7EXAMPLE")
        : undefined,
    ).messaging.send(sendInput("key REDACTED rotates tonight"));

    expect(receipt).toMatchObject({ kind: "denied", code: "secret_egress_denied" });
    expect(delivered).toEqual([]);
  });

  test("Given a clean body, When sent through the router, Then delivery is unaffected by the gate", async () => {
    const receipt = await router((channel) =>
      channel === "qa" ? (markdown) => markdown : undefined,
    ).messaging.send(sendInput("rollout complete"));

    expect(receipt.kind).toBe("sent");
    expect(delivered).toEqual(["rollout complete"]);
  });
});
