import { beforeEach, describe, expect, test } from "bun:test";
import { ChannelGrantStore } from "@openomni/ledger";
import {
  commits,
  kernelRouter,
  ownerFacts,
  ownerMessageTargets,
  ownerSender,
  resetRouterState,
} from "./_router-fixture";

beforeEach(() => {
  resetRouterState();
  ChannelGrantStore.put({
    id: "grant",
    surface: "discord",
    kind: "trusted_channel",
    defaultTier: "owner",
    createdBy: "owner",
  });
});

describe("GatewayRouter conversation isolation", () => {
  test("same physical surface routes later messages to the same session", async () => {
    const [first, second] = await ownerMessageTargets();
    expect(first).toBe(second);
    expect(commits).toHaveLength(2);
  });
  test.each([
    "workspaceId",
    "channelId",
  ] as const)("different %s isolates the target session", async (field) => {
    const [first, second] = await ownerMessageTargets({
      ...ownerFacts,
      eventId: "second",
      [field]: "other",
    });
    expect(first).not.toBe(second);
  });
  test("allowlist refuses strangers while admitting the authenticated listed sender", async () => {
    ChannelGrantStore.put({
      id: "grant",
      surface: "discord",
      kind: "trusted_channel",
      defaultTier: "owner",
      allowedSenders: [ownerSender.externalId],
      createdBy: "owner",
    });
    expect(
      await kernelRouter().ingest({ ...ownerSender, externalId: "stranger" }, ownerFacts),
    ).toMatchObject({ status: "blocked_pre" });
    expect(
      (await kernelRouter().ingest(ownerSender, { ...ownerFacts, eventId: "allowed" })).status,
    ).toBe("executed");
    expect(commits).toHaveLength(1);
  });
  test("invalid facts fail schema validation before routing", async () => {
    await expect(
      kernelRouter().ingest(ownerSender, { ...ownerFacts, eventId: "" }),
    ).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "too_small", path: ["eventId"] })],
    });
    expect(commits).toEqual([]);
  });
});
