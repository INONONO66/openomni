import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { extractSurfaceKey, type Gateway, type Ingress } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Storage } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import {
  type ChannelDeliveryRoute,
  createGatewayRouter,
  type GatewayRouter,
} from "../../../src/router/index.js";

/**
 * Covers the messaging-composed router path (#708): the router built WITH
 * messaging ports composes the send kernel over Owner grants + live
 * reply-grant instances, and a routed admission of a registered actor on a
 * rule-covered channel materializes a bounded reply-scoped instance. These
 * lines are otherwise exercised only by the apps/server E2E; this pins them
 * in the channels standalone suite.
 */

const delivered: Array<{ externalId: string; body: string; idempotencyKey: string }> = [];

function deliveryRoutes(): ReadonlyMap<string, ChannelDeliveryRoute> {
  return new Map<string, ChannelDeliveryRoute>([
    [
      "discord",
      async (externalId, body, idempotencyKey) => {
        delivered.push({ externalId, body, idempotencyKey });
        return { externalMessageId: `plat-${delivered.length}` };
      },
    ],
  ]);
}

const strangerEvent = {
  id: "inbound-stranger",
  traceId: "trace-compose",
  surface: "discord",
  workspace: "shop-ws",
  channel: "market",
  userId: "buyer-external",
  mode: "direct",
  payload: "is it still available?",
  meta: { actor: { role: "user" } },
} satisfies Gateway.DeliveredEvent;

function makeRouter(routes: ReadonlyMap<string, ChannelDeliveryRoute> = deliveryRoutes()): GatewayRouter {
  return createGatewayRouter({
    sink: (event, data) => Bus.publish(event, data),
    deliver: async (delivery: Gateway.Deliver): Promise<Ingress.IngressResult> => ({
      mode: "direct",
      target: delivery.event.target ?? { kind: "resident" },
      sessionId: delivery.sessionId ?? "s-stub",
      result: { output: "ok", finishReason: "stop" },
    }),
    messaging: {
      deliveryRoutes: routes,
      grants: () => [],
      replyGrantRules: () => [
        {
          id: "rule-market",
          senderId: "persona-owner",
          surface: "discord",
          workspace: "shop-ws",
          channel: "market",
          operations: ["awaited"],
          instanceTtlMs: 86_400_000,
          maxLiveInstances: 5,
          createdBy: "owner",
        },
      ],
    },
  });
}

beforeEach(() => {
  Storage.reset();
  Bus.reset();
  Storage.initialize({ dbPath: ":memory:" });
  delivered.length = 0;
  // A broadcast channel admits a first-contact stranger as evidence_only with
  // a resolved identity — the materialization precondition (routed + endpoint).
  // A broadcast channel admits a first-contact stranger as evidence_only —
  // the authorized top-level path for a non-owner initiator (the trusted
  // channel would deny a collaborator's top-level inbound).
  ChannelGrantStore.put({
    id: "grant-market",
    surface: "discord",
    workspace: "shop-ws",
    channel: "market",
    kind: "broadcast_channel",
    defaultTier: "collaborator",
    createdBy: "owner",
  });
  ActorRegistry.registerIdentity({ id: "actor-buyer", kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({
    id: "ep-buyer",
    actorId: "actor-buyer",
    channel: "discord",
    externalId: "buyer-external",
    workspace: "shop-ws",
  });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("messaging-composed gateway router (#708)", () => {
  test("exposes a fail-closed send kernel when messaging ports are provided", async () => {
    const router = makeRouter();
    // No Owner grant + no materialized instance yet → ungranted, fail-closed.
    const receipt = await router.messaging.send({
      messageId: "m-1",
      traceId: "t-1",
      senderId: "persona-owner",
      target: { actorId: "actor-buyer" },
      operation: "fire_and_forget",
      body: "hi",
      at: 1_000,
    });
    expect(receipt.kind).toBe("denied");
    if (receipt.kind === "denied") expect(receipt.code).toBe("ungranted");
  });

  test("a routed registered actor on a rule-covered channel materializes a reply-scoped grant, enabling the persona reply", async () => {
    const router = makeRouter();
    // Ingest the stranger's first contact verbatim — the router's actor
    // resolver fills actorId + endpoint from the registry (surface+externalId
    // +workspace), and the routed admission materializes the rule instance.
    const result = await router.ingest(strangerEvent);
    expect(result.mode).toBe("direct");

    // The materialized instance now lets the persona reply INTO that container
    // (awaited), where the scope-less base evaluator alone would still refuse.
    const receipt = await router.messaging.send({
      messageId: "m-2",
      traceId: "t-2",
      senderId: "persona-owner",
      target: { actorId: "actor-buyer", endpointId: "ep-buyer" },
      operation: "awaited",
      body: "yes, still available",
      at: 2_000,
      waitSpec: {
        waitId: "w-2",
        ownerRef: { kind: "session", id: "s-1" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-buyer"],
        resolutionPolicy: "first_reply",
        expiresAt: 999_999_999,
        followUpWindow: 0,
      },
    });
    expect(receipt.kind).toBe("sent");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      externalId: "buyer-external",
      idempotencyKey: "m-2",
    });
  });

  test("fails closed when no channel owner delivers a granted endpoint", async () => {
    const router = makeRouter(new Map());
    await router.ingest(strangerEvent);

    await expect(
      router.messaging.send({
        messageId: "m-owner-missing",
        traceId: "t-owner-missing",
        senderId: "persona-owner",
        target: { actorId: "actor-buyer", endpointId: "ep-buyer" },
        operation: "awaited",
        body: "must not disappear",
        at: 2_000,
        waitSpec: {
          waitId: "w-owner-missing",
          ownerRef: { kind: "session", id: "s-1" },
          allowedActions: ["report_result"],
          expectedResponders: ["actor-buyer"],
          resolutionPolicy: "first_reply",
          expiresAt: 999_999_999,
          followUpWindow: 0,
        },
      }),
    ).rejects.toThrow("no registered channel surface delivers discord");
  });

  test("preserves a covered reply grant across router restart", async () => {
    const firstRouter = makeRouter();
    await firstRouter.ingest(strangerEvent);

    // Constructing a new router over the same durable ledger stores simulates
    // process restart: no inbound replay occurs before the covered reply.
    const restartedRouter = makeRouter();
    const receipt = await restartedRouter.messaging.send({
      messageId: "m-restart",
      traceId: "t-restart",
      senderId: "persona-owner",
      target: { actorId: "actor-buyer", endpointId: "ep-buyer" },
      operation: "awaited",
      body: "yes, still available",
      at: Date.now(),
      waitSpec: {
        waitId: "w-restart",
        ownerRef: { kind: "session", id: "s-1" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-buyer"],
        resolutionPolicy: "first_reply",
        expiresAt: Date.now() + 60_000,
        followUpWindow: 0,
      },
    });

    expect(receipt.kind).toBe("sent");
  });

  test("denies a restarted reply when the endpoint was rebound to another container", async () => {
    const firstRouter = makeRouter();
    await firstRouter.ingest(strangerEvent);

    ActorRegistry.registerEndpoint({
      id: "ep-buyer",
      actorId: "actor-buyer",
      channel: "discord",
      externalId: "different-container",
      workspace: "shop-ws",
    });

    const restartedRouter = makeRouter();
    const receipt = await restartedRouter.messaging.send({
      messageId: "m-rebound",
      traceId: "t-rebound",
      senderId: "persona-owner",
      target: { actorId: "actor-buyer", endpointId: "ep-buyer" },
      operation: "awaited",
      body: "must not escape the initiating container",
      at: Date.now(),
      waitSpec: {
        waitId: "w-rebound",
        ownerRef: { kind: "session", id: "s-1" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-buyer"],
        resolutionPolicy: "first_reply",
        expiresAt: Date.now() + 60_000,
        followUpWindow: 0,
      },
    });

    expect(receipt.kind).toBe("denied");
    if (receipt.kind === "denied") expect(receipt.code).toBe("ungranted");
    expect(delivered).toEqual([]);
  });

  test("claimSurface returns the CAS owner and is idempotent for the same session", () => {
    const router = makeRouter();
    const key = extractSurfaceKey(strangerEvent);
    const first = router.claimSurface(key, "sess-A");
    expect(first).toBe("sess-A");
    // Insert-only (no expected): a second claim without expectedSessionId does
    // not clobber the live owner.
    expect(router.claimSurface(key, "sess-B")).toBe("sess-A");
  });
});
