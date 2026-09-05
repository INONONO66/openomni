import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGrantStore, SqliteStorageAdapter, Storage } from "../../src/index.js";

describe("ChannelGrantStore SQLite persistence", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "channel-grant-test-"));
    dbPath = join(tmpDir, "test.db");
    Storage.initialize({ dbPath });
  });

  afterEach(async () => {
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("persists grant JSON bytes without resolution-derived normalization", () => {
    ChannelGrantStore.put({
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

    const reader = new Database(dbPath, { readonly: true });
    const row = reader
      .query("SELECT data FROM channel_grant WHERE id = ?")
      .get("grant-byte-fixture") as { data: string };
    reader.close();

    expect(row.data).toBe(
      '{"id":"grant-byte-fixture","surface":"discord","workspace":"guild","channel":"design","kind":"broadcast_channel","defaultTier":"observer","inboundTreatment":"full_access","createdBy":"act_owner","createdAt":100,"updatedAt":200}',
    );
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

    Storage.reset();
    Storage.configure(new SqliteStorageAdapter(dbPath));

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
