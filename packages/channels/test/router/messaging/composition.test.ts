import { beforeEach, describe, expect, test } from "bun:test";
import { type Gateway, Ingress } from "@openomni/protocol";
import { ActorRegistry, ChannelGrantStore, Storage } from "@openomni/ledger";
import type { ChannelDeliveryRoute, GatewayRouter } from "../../../src/router/index.js";
import { makeRouter as makeFixtureRouter, resetRouterState } from "../_router-fixture";

/**
 * Covers the messaging-composed router path (#708): the router built WITH
 * messaging ports composes the send kernel over Owner grants + live
 * reply-grant instances, and a routed admission of a registered actor on a
 * rule-covered channel materializes a bounded reply-scoped instance. These
 * lines are exercised through the app composition; this pins them
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

function makeRouter(
  routes: ReadonlyMap<string, ChannelDeliveryRoute> = deliveryRoutes(),
  maxLiveInstances = 5,
): GatewayRouter {
  return makeFixtureRouter({
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
          maxLiveInstances,
          createdBy: "owner",
        },
      ],
    },
  });
}

beforeEach(() => {
  resetRouterState();
  delivered.length = 0;
  seedMarketState();
});

// A broadcast channel admits a first-contact stranger as evidence_only with
// a resolved identity — the materialization precondition (routed + endpoint).
// The trusted channel would deny a collaborator's top-level inbound.
function seedMarketState(): void {
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
}

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

  test("constructs without a ledger sub-adapter and replays no authority", () => {
    const adapter = Storage.get();
    Storage.configure({
      ...adapter,
      transaction: adapter.transaction.bind(adapter),
      ledger: undefined,
    });

    const router = makeRouter();

    expect(router.messaging).toBeDefined();
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

  test("replays the lexical winner of equal-time route facts and skips corrupt rows", async () => {
    // Given — capture the modern routed fact this inbound records today.
    await makeRouter().ingest(strangerEvent);
    const streamId = Ingress.routeStreamId(strangerEvent);
    const modern = Storage.get().ledger?.headFact(streamId);
    expect(modern?.data).toMatchObject({ outcome: "route" });

    // And — a fresh ledger seeded in the opposite order from the required
    // lexical tie-break. Both rows have the captured decision's exact time,
    // but the second row's stream id sorts first and carries the LEGACY shape
    // (dead fields that the strict write schema rejects).
    resetRouterState();
    seedMarketState();
    delivered.length = 0;
    const modernData = modern?.data as { factsUsed: string[] } & Record<string, unknown>;
    Storage.get().ledger?.append(
      {
        streamId: "route:discord:shop-ws:market:A-storage-first",
        type: "route.decided",
        data: modernData,
      },
      0,
    );
    ActorRegistry.registerIdentity({
      id: "actor-lexical-winner",
      kind: "human",
      trustTier: "collaborator",
    });
    ActorRegistry.registerEndpoint({
      id: "ep-lexical-winner",
      actorId: "actor-lexical-winner",
      channel: "discord",
      externalId: "lexical-winner-external",
      workspace: "shop-ws",
    });
    Storage.get().ledger?.append(
      {
        streamId: "route:discord:shop-ws:market:a-locale-winner",
        type: "route.decided",
        data: {
          ...modernData,
          inboundId: "a-locale-winner",
          actorId: "actor-lexical-winner",
          factsUsed: modernData.factsUsed.map((fact) =>
            fact.replace("buyer-external", "lexical-winner-external"),
          ),
          runId: "run-legacy",
          pendingInteractionId: "ask_legacy",
        },
      },
      0,
    );
    Storage.get().ledger?.append(
      {
        streamId: "route:discord:shop-ws:market:corrupt-row",
        type: "route.decided",
        data: { junk: true },
      },
      0,
    );

    // And — a routed fact for a second actor whose retired fields carry
    // wrong types (runId must be a string in every era): never valid, so it
    // must not reconstruct a grant.
    ActorRegistry.registerIdentity({
      id: "actor-mallory",
      kind: "human",
      trustTier: "collaborator",
    });
    ActorRegistry.registerEndpoint({
      id: "ep-mallory",
      actorId: "actor-mallory",
      channel: "discord",
      externalId: "mallory-external",
      workspace: "shop-ws",
    });
    Storage.get().ledger?.append(
      {
        streamId: Ingress.routeStreamId({ ...strangerEvent, id: "inbound-mallory" }),
        type: "route.decided",
        data: {
          ...modernData,
          inboundId: "inbound-mallory",
          actorId: "actor-mallory",
          factsUsed: modernData.factsUsed.map((fact) =>
            fact.replace("buyer-external", "mallory-external"),
          ),
          runId: 42,
        },
      },
      0,
    );

    // When — replay has capacity for exactly one instance, so the equal-time
    // sort directly determines which admission receives authority.
    const restarted = makeRouter(deliveryRoutes(), 1);
    const winnerReceipt = await restarted.messaging.send({
      messageId: "m-legacy-winner",
      traceId: "t-legacy-winner",
      senderId: "persona-owner",
      target: { actorId: "actor-lexical-winner", endpointId: "ep-lexical-winner" },
      operation: "awaited",
      body: "legacy lexical winner",
      at: Date.now(),
      waitSpec: {
        waitId: "w-legacy-winner",
        ownerRef: { kind: "session", id: "s-1" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-lexical-winner"],
        resolutionPolicy: "first_reply",
        expiresAt: Date.now() + 60_000,
        followUpWindow: 0,
      },
    });

    // Then — localeCompare selects "...:a-locale-winner" over
    // SQLite's earlier "...:A-storage-first". The receipt exposes the exact
    // source stream embedded in the one materialized grant's deterministic id.
    expect(winnerReceipt.kind).toBe("sent");
    if (winnerReceipt.kind === "sent") {
      expect(winnerReceipt.grantId).toBe(
        "reply-grant:rule-market:route%3Adiscord%3Ashop-ws%3Amarket%3Aa-locale-winner",
      );
    }
    expect(delivered).toEqual([
      {
        externalId: "lexical-winner-external",
        body: "legacy lexical winner",
        idempotencyKey: "m-legacy-winner",
      },
    ]);
    const insertionFirstReceipt = await restarted.messaging.send({
      messageId: "m-insertion-first",
      traceId: "t-insertion-first",
      senderId: "persona-owner",
      target: { actorId: "actor-buyer", endpointId: "ep-buyer" },
      operation: "awaited",
      body: "must lose equal-time tie-break",
      at: Date.now(),
      waitSpec: {
        waitId: "w-insertion-first",
        ownerRef: { kind: "session", id: "s-1" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-buyer"],
        resolutionPolicy: "first_reply",
        expiresAt: Date.now() + 60_000,
        followUpWindow: 0,
      },
    });
    expect(insertionFirstReceipt.kind).toBe("denied");
    if (insertionFirstReceipt.kind === "denied") {
      expect(insertionFirstReceipt.code).toBe("ungranted");
    }

    // And — the wrong-typed fact granted nothing: the send to mallory denies.
    const malloryReceipt = await restarted.messaging.send({
      messageId: "m-mallory",
      traceId: "t-mallory",
      senderId: "persona-owner",
      target: { actorId: "actor-mallory", endpointId: "ep-mallory" },
      operation: "awaited",
      body: "must stay ungranted",
      at: Date.now(),
      waitSpec: {
        waitId: "w-mallory",
        ownerRef: { kind: "session", id: "s-1" },
        allowedActions: ["report_result"],
        expectedResponders: ["actor-mallory"],
        resolutionPolicy: "first_reply",
        expiresAt: Date.now() + 60_000,
        followUpWindow: 0,
      },
    });
    expect(malloryReceipt.kind).toBe("denied");
    if (malloryReceipt.kind === "denied") expect(malloryReceipt.code).toBe("ungranted");
    expect(delivered).toHaveLength(1);
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
});
