import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Bus } from "@openomni/agent";
import { ActorRegistry, ChannelGrantStore, SessionHandleStore, Storage } from "@openomni/ledger";
import { Gateway } from "@openomni/protocol";
import { messageFixture } from "./helpers/message-fixture";

const directories: string[] = [];
afterEach(() => {
  Storage.reset(); Bus.reset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function registerTarget() {
  ActorRegistry.registerIdentity({ id: "target", kind: "human", trustTier: "owner" });
  ActorRegistry.registerEndpoint({ id: "ws:target", actorId: "target", channel: "ws", externalId: "target" });
}

test.each(["accepted", "rejected", "unknown"] as const)("app composition preserves actor %s in the committed message terminal", async (value) => {
  const keys: string[] = [];
  const fixture = messageFixture("resident", {
    deliveryRoutes: new Map([["ws", async (_id, _body, key) => { keys.push(key); return { value }; }]]),
    grants: () => [{ id: "grant", senderId: "sender", targetActorId: "target", operations: ["fire_and_forget"] }],
    budgets: () => [{ id: "budget", targetActorId: "target", maxPerWindow: 10, windowMs: 1000, cooldownMs: 0 }],
  });
  directories.push(fixture.directory); registerTarget();
  const result = await fixture.send({ to: { kind: "actor", actorId: "target" }, type: "message", content: "hello" });
  expect(result.isError).not.toBe(true);
  const handle = Gateway.SendMessageHandle.parse(JSON.parse(result.output));
  expect(keys).toEqual([handle.messageId]);
  const receipts = SessionHandleStore.tree(fixture.sessionId).flatMap((action) => {
    const effect = action.effect.value;
    if (action.kind !== "message" || effect === null || typeof effect !== "object" || Array.isArray(effect)) return [];
    const parsed = Gateway.IngestResult.safeParse(effect.result);
    return parsed.success ? [parsed.data] : [];
  });
  expect(receipts).toEqual([{ status: "executed", handle, delivery: { kind: "actor", value } }]);
});

test("ungranted app actor send is a compiled pre-denial, never an executed delivery", async () => {
  let calls = 0;
  const fixture = messageFixture("resident", {
    deliveryRoutes: new Map([["ws", async () => { calls += 1; return { value: "accepted" as const }; }]]),
    grants: () => [],
  });
  directories.push(fixture.directory); registerTarget();
  const result = await fixture.send({ to: { kind: "actor", actorId: "target" }, type: "message", content: "hello" });
  expect(result.isError).toBe(true);
  expect(result.output).toContain("message.resident.actor_grant");
  expect(calls).toBe(0);
  expect(SessionHandleStore.tree(fixture.sessionId).filter((action) => action.kind === "message")).toEqual([]);
  expect(SessionHandleStore.tree(fixture.sessionId).some((action) => action.kind === "policy.decision")).toBe(true);
});

test("app ingress applies the channel default tier as policy facts, not top-level authority", async () => {
  const fixture = messageFixture(); directories.push(fixture.directory);
  ChannelGrantStore.put({ id: "observer", surface: "discord", kind: "trusted_channel", defaultTier: "observer", createdBy: "owner" });
  expect(await fixture.gateway.ingest({ kind: "external", surface: "discord", externalId: "guest" }, {
    eventId: "guest", surface: "discord", channelId: "public", addressees: [], dm: false, payload: "instruction", render: "instruction",
  })).toEqual({ status: "blocked_pre", reasonCode: "message.external.grant_tier" });
  expect(SessionHandleStore.listRows().flatMap((row) => SessionHandleStore.inboxRows(row.id))).toEqual([]);
});
