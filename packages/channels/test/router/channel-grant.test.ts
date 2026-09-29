import { ledger } from "../helpers/ledger";
import { beforeEach, expect, test } from "bun:test";
import { runEffect } from "../helpers/effect";
import { registerChannelGrant } from "../helpers/channel-grant";
import { expectEvidenceOnlyCommit } from "./_evidence-only";
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
  ledger().stores.channelGrants.remove("grant-owner-dm");
  expect(await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).toMatchObject({
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
  expect(await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).toMatchObject({
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
  expect((await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).status).toBe("executed");
  expectEvidenceOnlyCommit();
});
