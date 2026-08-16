import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact as ArtifactSchema } from "@openomni/protocol";
import { Storage } from "../../src/storage/storage";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import "../../src/storage/initialize";
import { Artifact } from "../../src/artifact/index";

const now = new Date().toISOString();

function makeMeta(overrides: Partial<ArtifactSchema.Meta> = {}): ArtifactSchema.Meta {
  return {
    id: "art-1",
    sessionId: "sess-1",
    mimeType: "text/plain",
    title: "output.txt",
    version: 1,
    createdAt: now,
    ...overrides,
  };
}

function ensureSession(adapter: SqliteStorageAdapter, id: string): void {
  adapter.session.set(id, {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test-model" },
    time: { created: Date.now(), updated: Date.now() },
    spawnDepth: 0,
  });
}

describe("Artifact persistence (SQLite)", () => {
  let dbPath: string;
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `test-artifact-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    adapter = new SqliteStorageAdapter(dbPath);
    Storage.initialize({ dbPath: ":memory:" });
    Storage.configure(adapter);
    ensureSession(adapter, "sess-1");
  });

  afterEach(() => {
    Storage.reset();
    try {
      adapter.close();
    } catch {
      /* db may already be closed */
    }
    unlinkSync(dbPath);
  });

  test("store persists to SQLite and survives adapter recreation", () => {
    const meta = makeMeta();
    Artifact.store("sess-1", meta, "hello world");
    adapter.close();

    const adapter2 = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter2);

    const result = Artifact.get("art-1");
    expect(result).not.toBeNull();
    expect(result?.meta.id).toBe("art-1");
    expect(result?.content).toBe("hello world");

    adapter2.close();
  });

  test("independent artifacts recover from SQLite after reset", () => {
    Artifact.store("sess-1", makeMeta({ id: "art-1" }), "content-1");
    Artifact.store("sess-1", makeMeta({ id: "art-2" }), "content-2");
    adapter.close();

    const adapter2 = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter2);

    expect(Artifact.get("art-1")?.content).toBe("content-1");
    expect(Artifact.get("art-2")?.content).toBe("content-2");

    adapter2.close();
  });

  test("latest version wins in SQLite (upsert semantics)", () => {
    Artifact.store("sess-1", makeMeta({ version: 1 }), "v1");
    Artifact.store("sess-1", makeMeta({ version: 2, title: "updated.txt" }), "v2");
    adapter.close();

    const adapter2 = new SqliteStorageAdapter(dbPath);
    Storage.configure(adapter2);

    const result = Artifact.get("art-1");
    expect(result).not.toBeNull();
    expect(result?.meta.version).toBe(2);
    expect(result?.meta.title).toBe("updated.txt");
    expect(result?.content).toBe("v2");

    adapter2.close();
  });
});
