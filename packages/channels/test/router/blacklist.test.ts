import { beforeEach, expect, test } from "bun:test";
import { runEffect } from "../helpers/effect";
import { BlacklistStore } from "@openomni/ledger";
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

test.each([
  { kind: "actor", value: "actor-owner" },
  { kind: "channel", value: "discord:owner-workspace:owner-dm" },
] as const)("blacklisted $kind is refused before inbox commit", async (entry: { readonly kind: "actor"; readonly value: "actor-owner"; } | { readonly kind: "channel"; readonly value: "discord:owner-workspace:owner-dm"; }) => {
  BlacklistStore.put({ id: "blacklisted", ...entry, createdBy: "owner" });
  expect(await runEffect(kernelRouter().ingest(ownerSender, ownerFacts))).toMatchObject({
    status: "blocked_pre",
  });
  expect(routingDecisions()[0]).toMatchObject({ stage: "blacklist", outcome: "drop" });
  expect(commits).toEqual([]);
});
