import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
});
