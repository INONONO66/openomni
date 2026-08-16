import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SurfaceKey } from "../../src/surface-key";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import "../../src/storage/initialize";
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
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(new SqliteStorageAdapter(dbPath));
  });

  afterEach(async () => {
    Storage.reset();
    await rm(tmpDir, { recursive: true });
  });

  test("persists across Storage re-init", () => {
    const session = Session.create({
      traceId: "trace-surface-key",
      title: "persist-test",
      model: { providerID: "test", modelID: "test-model" },
    });
    SurfaceKey.claim("telegram:bot:chat:123", session.id);

    Storage.configure(new SqliteStorageAdapter(dbPath));

    expect(SurfaceKey.lookup("telegram:bot:chat:123")).toBe(session.id);
  });

  test("re-claim with expected owner updates session in SQLite", () => {
    const session1 = Session.create({
      traceId: "trace-surface-key",
      title: "old-session",
      model: { providerID: "test", modelID: "test-model" },
    });
    const session2 = Session.create({
      traceId: "trace-surface-key",
      title: "new-session",
      model: { providerID: "test", modelID: "test-model" },
    });
    SurfaceKey.claim("slack:ws:channel:C1", session1.id);
    SurfaceKey.claim("slack:ws:channel:C1", session2.id, session1.id);

    Storage.configure(new SqliteStorageAdapter(dbPath));

    expect(SurfaceKey.lookup("slack:ws:channel:C1")).toBe(session2.id);
  });
});
