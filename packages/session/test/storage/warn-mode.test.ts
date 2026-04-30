import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { initialize } from "../../src/storage/initialize";

let tmpDir: string;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "openomni-warn-test-"));
  Storage.reset();
  warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  Storage.reset();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Storage warn-mode", () => {
  test("warns once when get() called before initialize", () => {
    const adapter = Storage.get();
    expect(adapter).toBeDefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("Storage.get() called before initialize()");
  });

  test("warns only once on repeated get() calls", () => {
    Storage.get();
    Storage.get();
    Storage.get();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("does not warn after initialize with defaults", () => {
    initialize();
    Storage.get();
    expect(warnSpy).not.toHaveBeenCalled();
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

  test("does not warn after configure", () => {
    Storage.configure(new SqliteStorageAdapter(":memory:"));
    Storage.get();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
