import { beforeEach, describe, expect, test } from "bun:test";
import { ChannelGrantStore, Storage } from "@openomni/ledger";
import { resolveChannelGrant } from "../../src/router/channel-grant";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

describe("channel-grant sender allowlist", () => {
  test("an allowlisted grant matches only the listed sender", () => {
    ChannelGrantStore.put({
      id: "grant-telegram",
      surface: "telegram",
      kind: "trusted_channel",
      defaultTier: "owner",
      allowedSenders: ["111"],
      createdBy: "act_owner",
    });

    expect(resolveChannelGrant({ surface: "telegram", sender: "111" })?.grant.id).toBe(
      "grant-telegram",
    );
    // A stranger and an anonymous sender both find NO grant — the perimeter
    // blocks fail-closed on the miss.
    expect(resolveChannelGrant({ surface: "telegram", sender: "999" })).toBeUndefined();
    expect(resolveChannelGrant({ surface: "telegram" })).toBeUndefined();
  });

  test("a grant without an allowlist keeps the open posture", () => {
    ChannelGrantStore.put({
      id: "grant-ws",
      surface: "ws",
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "act_owner",
    });

    expect(resolveChannelGrant({ surface: "ws", sender: "anyone" })?.grant.id).toBe("grant-ws");
    expect(resolveChannelGrant({ surface: "ws" })?.grant.id).toBe("grant-ws");
  });

  test("a stranger falls through to a less restricted grant on the same surface", () => {
    ChannelGrantStore.put({
      id: "grant-owner-only",
      surface: "telegram",
      kind: "trusted_channel",
      defaultTier: "owner",
      allowedSenders: ["111"],
      createdBy: "act_owner",
    });
    ChannelGrantStore.put({
      id: "grant-public",
      surface: "telegram",
      kind: "broadcast_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
    });

    // The stranger never sees the owner-only grant. The owner matches BOTH,
    // and the lattice's fail-closed ordering (most restrictive treatment
    // wins) resolves the broadcast grant for them too — an Owner who wants
    // the owner tier for themselves simply does not stack a public grant on
    // the same surface.
    expect(resolveChannelGrant({ surface: "telegram", sender: "999" })?.grant.id).toBe(
      "grant-public",
    );
    expect(resolveChannelGrant({ surface: "telegram", sender: "111" })?.grant.id).toBe(
      "grant-public",
    );
  });
});
