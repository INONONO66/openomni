import { beforeEach, expect, test } from "bun:test";
import { ChannelGrantStore } from "@openomni/ledger";
import { registerChannelGrant } from "../helpers/channel-grant";
import {
  commits,
  kernelRouter,
  ownerFacts,
  ownerSender,
  registerOwnerDm,
  resetRouterState,
  routingDecisions,
} from "./_router-fixture";

beforeEach(() => {
  resetRouterState();
  registerOwnerDm();
});

test("registered Owner still needs a channel grant", async () => {
  ChannelGrantStore.remove("grant-owner-dm");
  expect(await kernelRouter().ingest(ownerSender, ownerFacts)).toMatchObject({
    status: "blocked_pre",
  });
  expect(commits).toEqual([]);
});

test("blocked channel overrides registered Owner authority", async () => {
  registerChannelGrant({
    id: "grant-owner-dm",
    workspace: "owner-workspace",
    channel: "owner-dm",
    kind: "blocked_channel",
  });
  expect(await kernelRouter().ingest(ownerSender, ownerFacts)).toMatchObject({
    status: "blocked_pre",
  });
  expect(routingDecisions()[0]).toMatchObject({ outcome: "block", inboundTreatment: "drop" });
  expect(commits).toEqual([]);
});

test("broadcast channel floors the Owner to evidence-only content", async () => {
  registerChannelGrant({
    id: "grant-owner-dm",
    workspace: "owner-workspace",
    channel: "owner-dm",
    kind: "broadcast_channel",
  });
  expect((await kernelRouter().ingest(ownerSender, ownerFacts)).status).toBe("executed");
  expect(routingDecisions()[0]).toMatchObject({
    outcome: "route",
    inboundTreatment: "evidence_only",
  });
  expect(commits).toHaveLength(1);
  expect(commits[0]?.content).not.toBe(ownerFacts.render);
  expect(commits[0]?.content.endsWith(ownerFacts.render)).toBe(true);
});
