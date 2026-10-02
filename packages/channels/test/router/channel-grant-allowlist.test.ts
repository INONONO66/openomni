import { ledger } from "../helpers/ledger";
import { beforeEach, describe, expect, test } from "bun:test";

import { resetGrantStore } from "../helpers/channel-grant";
import { resolveChannelGrant } from "../../src/router/channel-grant";

beforeEach(resetGrantStore);

describe("channel-grant sender allowlist", () => {
  test("an allowlisted grant matches only the listed sender", () => {
    ledger().stores.channelGrants.put({
      id: "grant-telegram",
      surface: "telegram",
      kind: "trusted_channel",
      defaultTier: "owner",
      allowedSenders: ["111"],
      createdBy: "act_owner",
    });

    expect(resolveChannelGrant(ledger().stores, { surface: "telegram", sender: "111" })?.grant.id).toBe(
      "grant-telegram",
    );
    // A stranger and an anonymous sender both find NO grant — the perimeter
    // blocks fail-closed on the miss.
    expect(resolveChannelGrant(ledger().stores, { surface: "telegram", sender: "999" })).toBeUndefined();
    expect(resolveChannelGrant(ledger().stores, { surface: "telegram" })).toBeUndefined();
  });

  test("a grant without an allowlist keeps the open posture", () => {
    ledger().stores.channelGrants.put({
      id: "grant-ws",
      surface: "ws",
      kind: "trusted_channel",
      defaultTier: "owner",
      createdBy: "act_owner",
    });

    expect(resolveChannelGrant(ledger().stores, { surface: "ws", sender: "anyone" })?.grant.id).toBe("grant-ws");
    expect(resolveChannelGrant(ledger().stores, { surface: "ws" })?.grant.id).toBe("grant-ws");
  });

  test("a stranger falls through to a less restricted grant on the same surface", () => {
    ledger().stores.channelGrants.put({
      id: "grant-owner-only",
      surface: "telegram",
      kind: "trusted_channel",
      defaultTier: "owner",
      allowedSenders: ["111"],
      createdBy: "act_owner",
    });
    ledger().stores.channelGrants.put({
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
    expect(resolveChannelGrant(ledger().stores, { surface: "telegram", sender: "999" })?.grant.id).toBe(
      "grant-public",
    );
    expect(resolveChannelGrant(ledger().stores, { surface: "telegram", sender: "111" })?.grant.id).toBe(
      "grant-public",
    );
  });
});
