import { beforeEach, expect, test } from "bun:test";
import { ChannelGrantStore } from "@openomni/ledger";
import { commits, kernelRouter, ownerFacts, ownerSender, resetRouterState } from "../_router-fixture";

beforeEach(resetRouterState);

test("unauthorized external sender cannot reach inbox commit", async () => {
  ChannelGrantStore.put({ id: "grant", surface: "discord", kind: "trusted_channel", createdBy: "owner" });
  expect(await kernelRouter().ingest(ownerSender, ownerFacts)).toMatchObject({ status: "blocked_pre" });
  expect(commits).toEqual([]);
});
