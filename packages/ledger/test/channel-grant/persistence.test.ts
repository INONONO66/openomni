import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGrantStore, SqliteStorageAdapter, Storage } from "../../src/index.js";

function createInsertionOrderedChannelGrantAdapter(): NonNullable<Storage.Adapter["channelGrant"]> {
  const grants = new Map<string, ChannelGrantStore.Grant>();
  return {
    get: (id) => grants.get(id),
    set: (grant) => grants.set(grant.id, grant),
    list: () => [...grants.values()],
    remove: (id) => grants.delete(id),
  };
}

function configureChannelGrantAdapter(
  channelGrant: NonNullable<Storage.Adapter["channelGrant"]>,
): void {
  const base = Storage.get();
  Storage.configure({
    transaction: base.transaction.bind(base),
    close: base.close?.bind(base),
    session: base.session,
    message: base.message,
    part: base.part,
    channelGrant,
  });
}

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

describe("ChannelGrantStore SQLite persistence", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "channel-grant-test-"));
    dbPath = join(tmpDir, "test.db");
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(new SqliteStorageAdapter(dbPath));
  });

  afterEach(async () => {
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("persists and resolves the most specific matching grant", () => {
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

    Storage.configure(new SqliteStorageAdapter(dbPath));

    const resolved = ChannelGrantStore.resolve({
      surface: "discord",
      workspace: "guild",
      channel: "design",
    });
    expect(resolved?.grant.id).toBe("grant-channel");
    expect(resolved?.inboundTreatment).toBe("evidence_only");
  });

  test("equal-specificity conflicts choose the restrictive grant regardless of insertion order", () => {
    const winners = [
      [permissiveGrant, restrictiveGrant],
      [restrictiveGrant, permissiveGrant],
    ].map((grants) => {
      configureChannelGrantAdapter(createInsertionOrderedChannelGrantAdapter());
      for (const grant of grants) ChannelGrantStore.put(grant);
      return ChannelGrantStore.resolve(equalSpecificityInput)?.grant.id;
    });

    expect(winners).toEqual([restrictiveGrant.id, restrictiveGrant.id]);
  });

  test("insertion-ordered and SQLite backends agree on equal-specificity conflicts", () => {
    configureChannelGrantAdapter(createInsertionOrderedChannelGrantAdapter());
    ChannelGrantStore.put(restrictiveGrant);
    ChannelGrantStore.put(permissiveGrant);
    const insertionOrderedWinner = ChannelGrantStore.resolve(equalSpecificityInput)?.grant.id;

    Storage.reset();
    Storage.configure(new SqliteStorageAdapter(dbPath));
    ChannelGrantStore.put(restrictiveGrant);
    ChannelGrantStore.put(permissiveGrant);
    const sqliteWinner = ChannelGrantStore.resolve(equalSpecificityInput)?.grant.id;

    expect([insertionOrderedWinner, sqliteWinner]).toEqual([
      restrictiveGrant.id,
      restrictiveGrant.id,
    ]);
  });

  test("equal-treatment conflicts fall through tier, kind, then id tie-breaks", () => {
    const surfaceInput = { surface: "discord" } as const;
    const resolveBothOrders = (
      first: ChannelGrantStore.Grant,
      second: ChannelGrantStore.Grant,
    ): (string | undefined)[] =>
      [
        [first, second],
        [second, first],
      ].map((grants) => {
        configureChannelGrantAdapter(createInsertionOrderedChannelGrantAdapter());
        for (const grant of grants) ChannelGrantStore.put(grant);
        return ChannelGrantStore.resolve(surfaceInput)?.grant.id;
      });

    // Same effective treatment (full_access): the lower default tier wins,
    // even though its id sorts later.
    const observerTier = {
      id: "b-observer",
      surface: "discord",
      kind: "trusted_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
    } as const satisfies ChannelGrantStore.Grant;
    const ownerTier = { ...observerTier, id: "a-owner", defaultTier: "owner" } as const;
    expect(resolveBothOrders(observerTier, ownerTier)).toEqual(["b-observer", "b-observer"]);

    // Same treatment and no tiers: the intrinsically more restrictive kind
    // wins, again against id order.
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

    // Fully tied grants resolve by grant id code-unit order as the stable key.
    const firstId = {
      id: "a-first",
      surface: "discord",
      kind: "trusted_channel",
      createdBy: "act_owner",
    } as const satisfies ChannelGrantStore.Grant;
    const secondId = { ...firstId, id: "b-second" } as const;
    expect(resolveBothOrders(firstId, secondId)).toEqual(["a-first", "a-first"]);
  });

  test("explicit inbound treatment overrides kind default", () => {
    ChannelGrantStore.put({
      id: "grant-override",
      surface: "discord",
      kind: "broadcast_channel",
      inboundTreatment: "full_access",
      createdBy: "act_owner",
    });

    expect(ChannelGrantStore.resolve({ surface: "discord" })?.inboundTreatment).toBe("full_access");
  });

  test("returns no resolution when no grant matches", () => {
    ChannelGrantStore.put({
      id: "grant-discord",
      surface: "discord",
      kind: "trusted_channel",
      createdBy: "act_owner",
    });

    expect(ChannelGrantStore.resolve({ surface: "telegram" })).toBeUndefined();
  });

  test("resolve fails closed when the channelGrant sub-adapter is absent", () => {
    const bare = Storage.get();
    Storage.configure({
      transaction: bare.transaction.bind(bare),
      session: bare.session,
      message: bare.message,
      part: bare.part,
    });

    expect(() => ChannelGrantStore.resolve({ surface: "discord" })).toThrow(
      "does not implement channel grants",
    );
  });
});
