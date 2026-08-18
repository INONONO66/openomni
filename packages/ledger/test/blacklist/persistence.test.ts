import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlacklistStore, SqliteStorageAdapter, Storage } from "../../src/index.js";

describe("BlacklistStore SQLite persistence", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "blacklist-test-"));
    dbPath = join(tmpDir, "test.db");
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(new SqliteStorageAdapter(dbPath));
  });

  afterEach(async () => {
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("persists and matches active blacklist entries across storage re-init", () => {
    BlacklistStore.put({
      id: "bl-actor",
      kind: "actor",
      value: "act_bad",
      reason: "abuse",
      createdBy: "act_owner",
    });

    Storage.configure(new SqliteStorageAdapter(dbPath));

    const matched = BlacklistStore.match({ actorId: "act_bad" });
    expect(matched?.id).toBe("bl-actor");
    expect(matched?.reason).toBe("abuse");
  });

  test("ignores expired blacklist entries", () => {
    BlacklistStore.put({
      id: "bl-expired",
      kind: "endpoint",
      value: "ep_old",
      expiresAt: 1,
      createdBy: "act_owner",
    });

    expect(BlacklistStore.match({ endpointId: "ep_old" }, 2)).toBeUndefined();
  });

  test("matches wildcard pattern entries against candidates", () => {
    BlacklistStore.put({
      id: "bl-pattern",
      kind: "pattern",
      value: "discord:guild:*",
      createdBy: "act_owner",
    });

    expect(BlacklistStore.match({ candidates: ["discord:guild:dev"] })?.id).toBe("bl-pattern");
    expect(BlacklistStore.match({ candidates: ["discord:other:dev"] })).toBeUndefined();
  });

  test("match fails closed when the blacklist sub-adapter is absent", () => {
    const bare = Storage.get();
    Storage.configure({
      transaction: bare.transaction.bind(bare),
      session: bare.session,
      message: bare.message,
      part: bare.part,
    });

    // Pre-fix behavior returned undefined ("not blacklisted") on an absent
    // adapter — a fail-open read of absolute-deny-gate data.
    expect(() => BlacklistStore.match({ actorId: "act_bad" })).toThrow(
      "does not implement blacklist",
    );
  });
});
