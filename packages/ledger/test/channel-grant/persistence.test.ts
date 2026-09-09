import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChannelGrantStore, Storage } from "../../src/index.js";
import { useSqliteStorage } from "../helpers/storage";
import { Actor } from "@openomni/protocol";

describe("ChannelGrantStore SQLite persistence", () => {
  const fixture = useSqliteStorage("channel-grant");

  test("persists grant fields without resolution-derived normalization", () => {
    const stored = ChannelGrantStore.put({
      id: "grant-byte-fixture",
      surface: "discord",
      workspace: "guild",
      channel: "design",
      kind: "broadcast_channel",
      defaultTier: "observer",
      inboundTreatment: "full_access",
      createdBy: "act_owner",
      createdAt: 100,
      updatedAt: 200,
    });

    using reader = new Database(fixture.path, { readonly: true });
    const row = reader
      .query<{ data: string }, [string]>("SELECT data FROM channel_grant WHERE id = ?")
      .get("grant-byte-fixture");
    if (row === null) throw new Error("missing persisted grant");
    expect(Actor.ChannelGrant.parse(JSON.parse(row.data))).toEqual(stored);
  });

  test("round-trips raw grant facts across adapter reconfiguration", () => {
    const stored = ChannelGrantStore.put({
      id: "grant-channel",
      surface: "discord",
      workspace: "guild",
      channel: "design",
      kind: "broadcast_channel",
      defaultTier: "observer",
      createdBy: "act_owner",
      createdAt: 100,
      updatedAt: 200,
    });

    fixture.reopen();

    expect(ChannelGrantStore.get(stored.id)).toEqual(stored);
    expect(ChannelGrantStore.list()).toEqual([stored]);
  });

  test("removes exactly one stored fact", () => {
    ChannelGrantStore.put({
      id: "grant-discord",
      surface: "discord",
      kind: "trusted_channel",
      createdBy: "act_owner",
    });

    expect(ChannelGrantStore.remove("grant-discord")).toBe(true);
    expect(ChannelGrantStore.get("grant-discord")).toBeUndefined();
    expect(ChannelGrantStore.remove("grant-discord")).toBe(false);
  });

  test("raw reads fail closed when the channelGrant sub-adapter is absent", () => {
    const bare = Storage.get();
    Storage.configure({
      transaction: bare.transaction.bind(bare),
      close: () => bare.close?.(),
    });

    expect(() => ChannelGrantStore.list()).toThrow("does not implement channel grants");
  });
});
