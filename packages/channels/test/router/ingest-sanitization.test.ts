import { beforeEach, expect, test } from "bun:test";
import {
  commits,
  kernelRouter,
  ownerFacts,
  ownerSender,
  registerOwnerDm,
  resetRouterState,
} from "./_router-fixture";

beforeEach(() => {
  resetRouterState();
  registerOwnerDm();
});

test.each([
  { activation: { durableSessionId: "attacker-session" } },
  { meta: { channelGrantId: "spoof-grant", channelGrantKind: "trusted_channel" } },
  { inboundTreatment: "evidence_only" },
  { senderTier: "owner" },
  { addressee: "bot" },
])("facts-only ingest rejects reserved fields: %j", async (reserved) => {
  await expect(
    kernelRouter().ingest(ownerSender, { ...ownerFacts, ...reserved }),
  ).rejects.toMatchObject({
    issues: [expect.objectContaining({ code: "unrecognized_keys" })],
  });
  expect(commits).toEqual([]);
});

test("authenticated surface must match the facts surface", async () => {
  await expect(
    kernelRouter().ingest({ ...ownerSender, surface: "telegram" }, ownerFacts),
  ).rejects.toThrow("authenticated surface mismatch");
  expect(commits).toEqual([]);
});
