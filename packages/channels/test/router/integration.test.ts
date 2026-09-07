import { beforeEach, describe, expect, test } from "bun:test";
import { ChannelGrantStore } from "@openomni/ledger";
import {
  commits,
  kernelRouter,
  ownerFacts,
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
    const first = await kernelRouter().ingest(ownerSender, ownerFacts);
    const second = await kernelRouter().ingest(ownerSender, { ...ownerFacts, eventId: "second" });
    if (first.status !== "executed" || second.status !== "executed")
      throw new Error("not executed");
    expect(first.handle.target).toBe(second.handle.target);
    expect(commits).toHaveLength(2);
  });
  test.each([
    "workspaceId",
    "channelId",
  ] as const)("different %s isolates the target session", async (field) => {
    const first = await kernelRouter().ingest(ownerSender, ownerFacts);
    const second = await kernelRouter().ingest(ownerSender, {
      ...ownerFacts,
      eventId: "second",
      [field]: "other",
    });
    if (first.status !== "executed" || second.status !== "executed")
      throw new Error("not executed");
    expect(first.handle.target).not.toBe(second.handle.target);
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
