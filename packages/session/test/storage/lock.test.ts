import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileLock } from "../../src/storage/lock";

let tempDir: string;
let lockPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "filelock-test-"));
  lockPath = join(tempDir, "test.lock");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("FileLock.acquire", () => {
  test("succeeds when no lock exists and creates lock directory", () => {
    FileLock.acquire(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    const info = JSON.parse(readFileSync(join(lockPath, "info.json"), "utf-8"));
    expect(info.pid).toBe(process.pid);
    expect(typeof info.timestamp).toBe("number");
    FileLock.release(lockPath);
  });

  test("overrides stale lock", () => {
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "info.json"),
      JSON.stringify({ pid: 99999, timestamp: Date.now() - 60_000 }),
    );

    FileLock.acquire(lockPath);
    const info = JSON.parse(readFileSync(join(lockPath, "info.json"), "utf-8"));
    expect(info.pid).toBe(process.pid);
    FileLock.release(lockPath);
  });

  test("overrides lock with missing info.json as stale", () => {
    mkdirSync(lockPath);

    FileLock.acquire(lockPath);
    expect(existsSync(join(lockPath, "info.json"))).toBe(true);
    FileLock.release(lockPath);
  });

  test("overrides lock with invalid info.json as stale", () => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "info.json"), "NOT_JSON");

    FileLock.acquire(lockPath);
    expect(existsSync(join(lockPath, "info.json"))).toBe(true);
    FileLock.release(lockPath);
  });

  test("throws on timeout when lock is held by active process", () => {
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "info.json"),
      JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
    );

    expect(() =>
      FileLock.acquire(lockPath, { timeoutMs: 150, pollMs: 50 }),
    ).toThrow(/timeout/i);

    rmSync(lockPath, { recursive: true, force: true });
  });
});

describe("FileLock.release", () => {
  test("removes lock directory recursively", () => {
    FileLock.acquire(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    FileLock.release(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("does not throw when lock does not exist", () => {
    expect(() => FileLock.release(lockPath)).not.toThrow();
  });
});

describe("FileLock.withLock", () => {
  test("runs fn and returns its value", () => {
    const result = FileLock.withLock(lockPath, () => 42);
    expect(result).toBe(42);
  });

  test("auto-releases on success", () => {
    FileLock.withLock(lockPath, () => {});
    expect(existsSync(lockPath)).toBe(false);
  });

  test("auto-releases on error and re-throws", () => {
    const err = new Error("boom");
    expect(() =>
      FileLock.withLock(lockPath, () => {
        throw err;
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("FileLock.isLocked", () => {
  test("returns false when no lock exists", () => {
    expect(FileLock.isLocked(lockPath)).toBe(false);
  });

  test("returns true when lock is held", () => {
    FileLock.acquire(lockPath);
    expect(FileLock.isLocked(lockPath)).toBe(true);
    FileLock.release(lockPath);
  });

  test("returns false when lock is stale", () => {
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "info.json"),
      JSON.stringify({ pid: 99999, timestamp: Date.now() - 60_000 }),
    );
    expect(FileLock.isLocked(lockPath)).toBe(false);
  });
});
