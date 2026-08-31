import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { initialize } from "../../src/storage/initialize";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "openomni-fail-closed-test-"));
  Storage.reset();
});

afterEach(() => {
  Storage.reset();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Storage fail-closed", () => {
  test("get() before initialize throws — no in-memory fallback", () => {
    expect(() => Storage.get()).toThrow("Storage.get() called before initialize()");
  });

  test("repeated get() keeps throwing and creates no adapter state", () => {
    expect(() => Storage.get()).toThrow();
    expect(() => Storage.get()).toThrow("Storage.get() called before initialize()");
    expect(Storage.getInitializedDbPath()).toBeNull();
  });

  test("get() works after initialize with defaults", () => {
    initialize();
    expect(Storage.get()).toBeInstanceOf(SqliteStorageAdapter);
  });

  test("idempotent same path — no throw", () => {
    const dbPath = join(tmpDir, "test.db");
    initialize({ dbPath });
    expect(() => initialize({ dbPath })).not.toThrow();
  });

  test("throws on conflicting dbPath", () => {
    initialize({ dbPath: join(tmpDir, "a.db") });
    expect(() => initialize({ dbPath: join(tmpDir, "b.db") })).toThrow("different dbPath");
  });

  test("get() works after configure", () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    expect(Storage.get()).toBeInstanceOf(SqliteStorageAdapter);
  });

  test("withIsolation scope starts uninitialized even when the outer scope is initialized", () => {
    initialize({ dbPath: join(tmpDir, "outer.db") });
    Storage.withIsolation(() => {
      expect(() => Storage.get()).toThrow("Storage.get() called before initialize()");
    });
    expect(Storage.get()).toBeInstanceOf(SqliteStorageAdapter);
  });
});
