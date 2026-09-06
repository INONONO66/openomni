import { beforeEach, expect, test } from "bun:test";
import { BlacklistStore } from "@openomni/ledger";
import { commits, kernelRouter, ownerFacts, ownerSender, registerOwnerDm, resetRouterState, routingDecisions } from "./_router-fixture";

beforeEach(() => { resetRouterState(); registerOwnerDm(); });

test.each([
  { kind: "actor", value: "actor-owner" },
  { kind: "channel", value: "discord:owner-workspace:owner-dm" },
] as const)("blacklisted $kind is refused before inbox commit", async (entry) => {
  BlacklistStore.put({ id: "blacklisted", ...entry, createdBy: "owner" });
  expect(await kernelRouter().ingest(ownerSender, ownerFacts)).toMatchObject({ status: "blocked_pre" });
  expect(routingDecisions()[0]).toMatchObject({ stage: "blacklist", outcome: "drop" });
  expect(commits).toEqual([]);
});
