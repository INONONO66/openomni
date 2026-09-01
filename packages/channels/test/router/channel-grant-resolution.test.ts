import { beforeEach, describe, expect, test } from "bun:test";
import { ChannelGrantStore, Storage } from "@openomni/ledger";
import { resolveChannelGrant } from "../../src/router/channel-grant";

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

const restrictiveGrant = {
  id: "z-restrictive",
  surface: "discord",
  workspace: "guild",
  kind: "blocked_channel",
  createdBy: "act_owner",
  createdAt: 200,
} as const satisfies ChannelGrantStore.Grant;

const permissiveGrant = {
  id: "a-permissive",
  surface: "discord",
  channel: "design",
  kind: "trusted_channel",
  defaultTier: "owner",
  createdBy: "act_owner",
  createdAt: 100,
} as const satisfies ChannelGrantStore.Grant;

const equalSpecificityInput = {
  surface: "discord",
  workspace: "guild",
  channel: "design",
} as const;

function resolveBothOrders(
  first: ChannelGrantStore.Grant,
  second: ChannelGrantStore.Grant,
): (string | undefined)[] {
  return [
    [first, second],
    [second, first],
  ].map((grants) => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    for (const grant of grants) ChannelGrantStore.put(grant);
    return resolveChannelGrant({ surface: "discord" })?.grant.id;
  });
}

describe("channel grant authority", () => {
  test("chooses the most specific matching grant", () => {
    ChannelGrantStore.put({
      id: "grant-surface",
      surface: "discord",
      kind: "trusted_channel",
      createdBy: "act_owner",
    });
    ChannelGrantStore.put({
      id: "grant-channel",
      surface: "discord",
      workspace: "guild",
      channel: "design",
      kind: "broadcast_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
    });

    expect(resolveChannelGrant(equalSpecificityInput)).toMatchObject({
      grant: { id: "grant-channel" },
      inboundTreatment: "evidence_only",
    });
  });

  test("equal-specificity conflicts choose the restrictive grant regardless of insertion order", () => {
    const winners = [
      [permissiveGrant, restrictiveGrant],
      [restrictiveGrant, permissiveGrant],
    ].map((grants) => {
      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });
      for (const grant of grants) ChannelGrantStore.put(grant);
      return resolveChannelGrant(equalSpecificityInput)?.grant.id;
    });

    expect(winners).toEqual([restrictiveGrant.id, restrictiveGrant.id]);
  });

  test("equal-treatment conflicts fall through tier, kind, then id tie-breaks", () => {
    const observerTier = {
      id: "b-observer",
      surface: "discord",
      kind: "trusted_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
    } as const satisfies ChannelGrantStore.Grant;
    const ownerTier = { ...observerTier, id: "a-owner", defaultTier: "owner" } as const;
    expect(resolveBothOrders(observerTier, ownerTier)).toEqual(["b-observer", "b-observer"]);

    const broadcastKind = {
      id: "b-broadcast",
      surface: "discord",
      kind: "broadcast_channel",
      createdBy: "act_owner",
    } as const satisfies ChannelGrantStore.Grant;
    const trustedEvidence = {
      id: "a-trusted",
      surface: "discord",
      kind: "trusted_channel",
      inboundTreatment: "evidence_only",
      createdBy: "act_owner",
    } as const satisfies ChannelGrantStore.Grant;
    expect(resolveBothOrders(broadcastKind, trustedEvidence)).toEqual([
      "b-broadcast",
      "b-broadcast",
    ]);

    const firstId = {
      id: "a-first",
      surface: "discord",
      kind: "trusted_channel",
      createdBy: "act_owner",
    } as const satisfies ChannelGrantStore.Grant;
    expect(resolveBothOrders(firstId, { ...firstId, id: "b-second" })).toEqual([
      "a-first",
      "a-first",
    ]);
  });

  test("normalizes an explicit treatment against the grant kind exactly once", () => {
    ChannelGrantStore.put({
      id: "grant-override",
      surface: "discord",
      kind: "broadcast_channel",
      inboundTreatment: "full_access",
      createdBy: "act_owner",
    });

    expect(resolveChannelGrant({ surface: "discord" })?.inboundTreatment).toBe("evidence_only");
  });

  test("returns no resolution when no raw fact matches", () => {
    ChannelGrantStore.put({
      id: "grant-discord",
      surface: "discord",
      kind: "trusted_channel",
      createdBy: "act_owner",
    });

    expect(resolveChannelGrant({ surface: "telegram" })).toBeUndefined();
  });
});
