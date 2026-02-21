import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Storage, InMemoryStorage } from "../../src/storage/storage";
import { CachedStorageAdapter } from "../../src/storage/cache";
import { FileStorageAdapter } from "../../src/storage/file-storage";
import { initialize } from "../../src/storage/initialize";

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
    initialize({ cwd: tmpDir });
    expect(existsSync(join(tmpDir, ".openomni"))).toBe(true);
  });

  test("creates subdirectories for file storage", () => {
    initialize({ cwd: tmpDir });
    const base = join(tmpDir, ".openomni");
    expect(existsSync(join(base, "sessions"))).toBe(true);
    expect(existsSync(join(base, "messages"))).toBe(true);
    expect(existsSync(join(base, "parts"))).toBe(true);
  });

  test("configures adapter as CachedStorageAdapter", () => {
    initialize({ cwd: tmpDir });
    expect(Storage.getAdapter()).toBeInstanceOf(CachedStorageAdapter);
  });

  test("adapter is not InMemoryStorage after initialize", () => {
    initialize({ cwd: tmpDir });
    expect(Storage.getAdapter()).not.toBeInstanceOf(InMemoryStorage);
  });

  test("sessions persist to disk", () => {
    initialize({ cwd: tmpDir });

    const session = {
      id: "s1",
      title: "Persisted",
      model: { providerID: "test", modelID: "test-model" },
      time: { created: Date.now(), updated: Date.now() },
    };
    Storage.getAdapter().session.set("s1", session);

    const verifyAdapter = new FileStorageAdapter(join(tmpDir, ".openomni"));
    const recovered = verifyAdapter.session.get("s1");
    expect(recovered).toBeDefined();
    expect(recovered?.title).toBe("Persisted");
  });

  test("updates .gitignore with storage directory pattern", () => {
    initialize({ cwd: tmpDir });
    const content = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain(".openomni/");
  });

  test("is idempotent — no error on second call", () => {
    initialize({ cwd: tmpDir });
    expect(() => initialize({ cwd: tmpDir })).not.toThrow();
  });

  test("is idempotent — no duplicate gitignore entries", () => {
    initialize({ cwd: tmpDir });
    initialize({ cwd: tmpDir });
    const content = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    const matches = content
      .split("\n")
      .filter((line) => line.trim() === ".openomni/");
    expect(matches).toHaveLength(1);
  });

  test("custom dir option works", () => {
    initialize({ dir: ".custom-data", cwd: tmpDir });
    expect(existsSync(join(tmpDir, ".custom-data"))).toBe(true);
    const content = readFileSync(join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain(".custom-data/");
  });

  test("defaults dir to .openomni when not specified", () => {
    initialize({ cwd: tmpDir });
    expect(existsSync(join(tmpDir, ".openomni"))).toBe(true);
  });

  test("Storage.initialize is callable on the namespace", () => {
    expect(typeof Storage.initialize).toBe("function");
    Storage.initialize({ cwd: tmpDir });
    expect(Storage.getAdapter()).toBeInstanceOf(CachedStorageAdapter);
  });
});
