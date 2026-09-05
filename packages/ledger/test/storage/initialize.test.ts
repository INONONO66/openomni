import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { initialize } from "../../src/storage/initialize";
import { materializeSession } from "../helpers/session";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "openomni-init-test-"));
  Storage.reset();
});

afterEach(() => {
  Storage.reset();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Storage.initialize", () => {
  test("creates storage directory", () => {
    initialize({ dbPath: join(tmpDir, ".openomni", "storage.db") });
    expect(existsSync(join(tmpDir, ".openomni"))).toBe(true);
  });

  test("default backend is sqlite", () => {
    initialize({ dbPath: join(tmpDir, ".openomni", "storage.db") });
    expect(Storage.get()).toBeInstanceOf(SqliteStorageAdapter);
  });

  test("refuses an incomplete production sqlite adapter before first use", () => {
    const adapter = new SqliteStorageAdapter(":memory:");
    Object.defineProperty(adapter, "wait", { configurable: true, value: undefined });

    let refusal: unknown;
    try {
      Storage.configure(adapter);
    } catch (error) {
      refusal = error;
    } finally {
      adapter.close();
    }

    expect((refusal as Error).name).toBe("IncompleteAdapterError");
    expect(refusal).toMatchObject({ code: "incomplete_adapter", capability: "wait" });
    expect((refusal as Error).message).toBe(
      "Production storage adapter is missing required capability: wait",
    );
    expect(() => Storage.get()).toThrow("Storage.get() called before initialize()");
  });

  test("sessions persist to disk with sqlite backend", () => {
    const dbPath = join(tmpDir, ".openomni", "storage.db");
    initialize({ dbPath });

    const session = materializeSession("s1");
    Storage.reset();
    const verifyAdapter = new SqliteStorageAdapter(dbPath);
    try {
      expect(verifyAdapter.sessions.get("s1")).toEqual(session);
      expect(verifyAdapter.actions.tree("s1")).toHaveLength(1);
    } finally {
      verifyAdapter.close();
    }
  });

  test("is idempotent — no error on second call", () => {
    const dbPath = join(tmpDir, ".openomni", "storage.db");
    initialize({ dbPath });
    expect(() => initialize({ dbPath })).not.toThrow();
  });

  test("dbPath option creates parent directory", () => {
    const dbPath = join(tmpDir, "custom", "session.db");
    initialize({ dbPath });
    expect(existsSync(join(tmpDir, "custom"))).toBe(true);
  });

  test("custom dbPath works", () => {
    const dbPath = join(tmpDir, "custom", "session.db");
    initialize({ dbPath });
    expect(Storage.get()).toBeInstanceOf(SqliteStorageAdapter);
  });

  test("initializes an isolated storage scope even when the parent uses the same path", () => {
    const dbPath = join(tmpDir, ".openomni", "storage.db");
    initialize({ dbPath });
    const parentAdapter = Storage.get();

    Storage.withIsolation(() => {
      try {
        expect(() => initialize({ dbPath })).not.toThrow();
        expect(Storage.get()).toBeInstanceOf(SqliteStorageAdapter);
        expect(Storage.get()).not.toBe(parentAdapter);
        expect(Storage.getInitializedDbPath()).toBe(dbPath);
        materializeSession("isolated-session");
      } finally {
        Storage.reset();
      }
    });

    expect(parentAdapter.sessions?.get("isolated-session")?.role).toBe("resident");
  });

  test("Storage.initialize is callable on the namespace", () => {
    expect(typeof Storage.initialize).toBe("function");
    Storage.initialize({ dbPath: join(tmpDir, ".openomni", "storage.db") });
    expect(Storage.get()).toBeInstanceOf(SqliteStorageAdapter);
  });
});
