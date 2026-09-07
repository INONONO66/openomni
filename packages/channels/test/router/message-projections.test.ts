import { beforeEach, expect, test } from "bun:test";
import { ActorRegistry, ChannelGrantStore, SessionHandleStore } from "@openomni/ledger";
import type { GatewayRouterPorts } from "../../src/router";
import { commits, makeRouter, resetRouterState } from "./_router-fixture";

beforeEach(resetRouterState);

test.each([
  "bot",
  "owner",
  "ambient",
] as const)("perimeter resolves %s addressee independently from sender standing", async (addressee) => {
  ChannelGrantStore.put({
    id: "channel",
    surface: "ws",
    kind: "trusted_channel",
    defaultTier: "owner",
    createdBy: "owner",
  });
  ActorRegistry.registerIdentity({
    id: "addressee",
    kind: addressee === "bot" ? "resident" : "human",
    trustTier: addressee === "owner" ? "owner" : "observer",
  });
  ActorRegistry.registerEndpoint({
    id: "ws:addressee",
    actorId: "addressee",
    channel: "ws",
    externalId: "mentioned",
  });
  const projected: Array<Parameters<GatewayRouterPorts["run"]>[1]["message"]> = [];
  const router = makeRouter({
    run: async (_sender, request) => {
      projected.push(request.message);
      return { terminal: "blocked_pre", reason: "capture", matchedRuleIds: [] };
    },
  });
  await router.ingest(
    { kind: "external", surface: "ws", externalId: "owner" },
    {
      eventId: "mention",
      surface: "ws",
      channelId: "room",
      dm: false,
      addressees: [{ externalId: "mentioned" }],
      payload: "hello",
      render: "hello",
    },
  );
  expect(projected).toMatchObject([{ sender: "external", senderTier: "owner", addressee }]);
  expect(ActorRegistry.resolveEndpoint("ws", "owner")?.identity.trustTier).toBe("owner");
  expect(commits).toEqual([]);
});

test("session deadline is part of the inbox commit, never a second alarm write", async () => {
  const router = makeRouter({
    clock: () => 10,
  });
  const result = await router.ingest(
    { kind: "session", id: "sender" },
    {
      to: { kind: "session", id: "child" },
      type: "message",
      content: "question",
      deadline: 100,
      replyTo: "binding",
    },
  );
  expect(result.status).toBe("executed");
  if (result.status !== "executed") throw new Error("not executed");
  expect(SessionHandleStore.tree("sender").filter(action => action.kind === "alarm.arm")).toEqual([]);
  expect(SessionHandleStore.requestRows("sender")).toMatchObject([{ deadline: 100, expectedResponders: ["child"] }]);
  expect(commits).toHaveLength(1);
  expect(commits[0]?.origin.value).toMatchObject({
    kind: "message",
    messageId: result.handle.messageId,
    senderSessionId: "sender",
    sourceActionId: expect.any(String),
    deadline: 100,
    replyTo: "binding",
  });
});
