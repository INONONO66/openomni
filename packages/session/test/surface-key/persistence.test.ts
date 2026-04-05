import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SurfaceKey } from "../../src/surface-key";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { Session } from "../../src/session";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("SurfaceKey SQLite persistence", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "surfacekey-test-"));
    dbPath = join(tmpDir, "test.db");
    Storage.configure(new SqliteStorageAdapter(dbPath));
    SurfaceKey.clear();
  });

  afterEach(async () => {
    Storage.reset();
    SurfaceKey.clear();
    await rm(tmpDir, { recursive: true });
  });

  test("persists across Storage re-init", () => {
    const session = Session.create({ title: "persist-test" });
    SurfaceKey.register("telegram:bot:chat:123", session.id);

    Storage.configure(new SqliteStorageAdapter(dbPath));
    SurfaceKey.clear();

    expect(SurfaceKey.lookup("telegram:bot:chat:123")).toBe(session.id);
  });

  test("unregister removes from SQLite", () => {
    const session = Session.create({ title: "unregister-test" });
    SurfaceKey.register("slack:ws:dm:U1", session.id);

    SurfaceKey.unregister("slack:ws:dm:U1");

    Storage.configure(new SqliteStorageAdapter(dbPath));
    SurfaceKey.clear();

    expect(SurfaceKey.lookup("slack:ws:dm:U1")).toBeUndefined();
  });

  test("re-register updates session in SQLite", () => {
    const session1 = Session.create({ title: "old-session" });
    const session2 = Session.create({ title: "new-session" });
    SurfaceKey.register("slack:ws:channel:C1", session1.id);
    SurfaceKey.register("slack:ws:channel:C1", session2.id);

    Storage.configure(new SqliteStorageAdapter(dbPath));
    SurfaceKey.clear();

    expect(SurfaceKey.lookup("slack:ws:channel:C1")).toBe(session2.id);
  });
});
