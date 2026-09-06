import { beforeEach, expect, test } from "bun:test";
import { ActorRegistry, ChannelGrantStore, Storage } from "@openomni/ledger";
import type { Gateway } from "@openomni/protocol";
import type { ChannelDeliveryRoute } from "../../../src/router";
import { makeRouter as makeFixtureRouter, resetRouterState } from "../_router-fixture";

const delivered: Array<{ externalId: string; body: string; idempotencyKey: string }> = [];
const sender = { kind: "external", surface: "discord", externalId: "buyer-external" } as const;
const facts: Gateway.IngressFacts = {
  eventId: "contact", surface: "discord", workspaceId: "shop-ws", channelId: "market",
  addressees: [], dm: false, payload: "available?", render: "available?",
};
const reply: Gateway.SendMessage = { to: { kind: "actor", actorId: "actor-buyer" }, type: "message", content: "yes", deadline: Number.MAX_SAFE_INTEGER };

function makeRouter(routes?: ReadonlyMap<string, ChannelDeliveryRoute>) {
  return makeFixtureRouter({
    messaging: {
      deliveryRoutes: routes ?? new Map([["discord", async (externalId, body, idempotencyKey) => {
        delivered.push({ externalId, body, idempotencyKey });
        return { value: "accepted", externalMessageId: `platform-${delivered.length}` };
      }]]),
      grants: () => [],
      replyGrantRules: () => [{ id: "market", senderId: "persona-owner", surface: "discord", workspace: "shop-ws", channel: "market", operations: ["awaited"], instanceTtlMs: 86_400_000, maxLiveInstances: 5, createdBy: "owner" }],
    },
  });
}

beforeEach(() => {
  resetRouterState(); delivered.length = 0;
  ChannelGrantStore.put({ id: "market", surface: "discord", workspace: "shop-ws", channel: "market", kind: "broadcast_channel", defaultTier: "collaborator", createdBy: "owner" });
  ActorRegistry.registerIdentity({ id: "actor-buyer", kind: "human", trustTier: "collaborator" });
  ActorRegistry.registerEndpoint({ id: "ep-buyer", actorId: "actor-buyer", channel: "discord", externalId: "buyer-external", workspace: "shop-ws" });
});

test("ungranted actor send is refused before transport", async () => {
  expect(await makeRouter().ingest({ kind: "session", id: "persona-owner" }, reply)).toMatchObject({ status: "blocked_pre" });
  expect(delivered).toEqual([]);
});

test("admitted first contact grants a scoped reply through the same ingest", async () => {
  const router = makeRouter();
  expect((await router.ingest(sender, facts)).status).toBe("executed");
  const sent = await router.ingest({ kind: "session", id: "persona-owner" }, reply);
  expect(sent).toMatchObject({ status: "executed", delivery: { kind: "actor", value: "accepted" } });
  if (sent.status !== "executed") throw new Error("not executed");
  expect(delivered).toEqual([{ externalId: "buyer-external", body: "yes", idempotencyKey: sent.handle.messageId }]);
});

test("a granted endpoint without a channel delivery owner fails closed", async () => {
  const router = makeRouter(new Map());
  await router.ingest(sender, facts);
  await expect(router.ingest({ kind: "session", id: "persona-owner" }, reply)).rejects.toThrow("no delivery route: discord");
  expect(delivered).toEqual([]);
});

test("restart reads the durable live-grant projection, never route history", async () => {
  await makeRouter().ingest(sender, facts);
  const adapter = Storage.get();
  const ledger = adapter.ledger;
  if (ledger === undefined) throw new Error("missing ledger");
  Storage.configure({ ...adapter, transaction: adapter.transaction.bind(adapter), ledger: {
    ...ledger, factsByType: () => { throw new Error("route history replay is forbidden"); },
  } });
  const restarted = makeRouter();
  expect(await restarted.ingest({ kind: "session", id: "persona-owner" }, reply)).toMatchObject({ status: "executed", delivery: { kind: "actor", value: "accepted" } });
});

test("historical route facts cannot reconstruct authority on restart", async () => {
  Storage.get().ledger?.append({ streamId: "route:forged", type: "route.decided", data: { outcome: "route", actorId: "actor-buyer" } }, 0);
  expect(await makeRouter().ingest({ kind: "session", id: "persona-owner" }, reply)).toMatchObject({ status: "blocked_pre" });
  expect(delivered).toEqual([]);
});

test("endpoint rebinding invalidates a durable reply grant", async () => {
  await makeRouter().ingest(sender, facts);
  ActorRegistry.registerEndpoint({ id: "ep-buyer", actorId: "actor-buyer", channel: "discord", externalId: "other-container", workspace: "shop-ws" });
  expect(await makeRouter().ingest({ kind: "session", id: "persona-owner" }, reply)).toMatchObject({ status: "blocked_pre" });
  expect(delivered).toEqual([]);
});

test.each(["accepted", "rejected", "unknown"] as const)("actor %s receipt survives the composed router", async (value) => {
  const router = makeRouter(new Map([["discord", async () => ({ value })]]));
  await router.ingest(sender, facts);
  expect(await router.ingest({ kind: "session", id: "persona-owner" }, reply)).toMatchObject({ status: "executed", delivery: { kind: "actor", value } });
});
