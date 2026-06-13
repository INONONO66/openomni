import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Artifact } from "../../src/artifact/index";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";
import type { Artifact as ArtifactSchema } from "@openomni/protocol";

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

function seedSession(id: string): void {
  Storage.getAdapter().session.set(id, {
    id,
    title: "test",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now(), updated: Date.now() },
    spawnDepth: 0,
  });
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

describe("Artifact", () => {
  describe("store and get", () => {
    it("stores and retrieves an artifact", async () => {
      seedSession("sess-1");
      const meta = makeMeta();
      await Artifact.store("sess-1", meta, "hello world");

      const result = await Artifact.get("art-1");
      expect(result).not.toBeNull();
      expect(result?.meta.id).toBe("art-1");
      expect(result?.meta.title).toBe("output.txt");
      expect(result?.content).toBe("hello world");
    });

    it("returns null for missing artifact", async () => {
      const result = await Artifact.get("nonexistent");
      expect(result).toBeNull();
    });

    it("returns latest version on get", async () => {
      seedSession("sess-1");
      const v1 = makeMeta({ version: 1 });
      const v2 = makeMeta({ version: 2, title: "output-v2.txt" });

      await Artifact.store("sess-1", v1, "version 1 content");
      await Artifact.store("sess-1", v2, "version 2 content");

      const result = await Artifact.get("art-1");
      expect(result).not.toBeNull();
      expect(result?.meta.version).toBe(2);
      expect(result?.meta.title).toBe("output-v2.txt");
      expect(result?.content).toBe("version 2 content");
    });
  });

  describe("list", () => {
    it("lists artifacts for a session", async () => {
      seedSession("sess-1");
      await Artifact.store("sess-1", makeMeta({ id: "art-1" }), "content-1");
      await Artifact.store("sess-1", makeMeta({ id: "art-2" }), "content-2");

      const items = await Artifact.list("sess-1");
      expect(items).toHaveLength(2);

      const ids = items.map((m) => m.id);
      expect(ids).toContain("art-1");
      expect(ids).toContain("art-2");
    });

    it("returns empty array for unknown session", async () => {
      const items = await Artifact.list("unknown");
      expect(items).toHaveLength(0);
    });

    it("deduplicates to latest version per artifact", async () => {
      seedSession("sess-1");
      await Artifact.store("sess-1", makeMeta({ id: "art-1", version: 1 }), "v1");
      await Artifact.store(
        "sess-1",
        makeMeta({ id: "art-1", version: 2, title: "updated.txt" }),
        "v2",
      );

      const items = await Artifact.list("sess-1");
      expect(items).toHaveLength(1);
      expect(items[0].version).toBe(2);
      expect(items[0].title).toBe("updated.txt");
    });

    it("isolates artifacts between sessions", async () => {
      seedSession("sess-1");
      seedSession("sess-2");
      await Artifact.store("sess-1", makeMeta({ id: "art-1" }), "c1");
      await Artifact.store("sess-2", makeMeta({ id: "art-2", sessionId: "sess-2" }), "c2");

      const s1 = await Artifact.list("sess-1");
      const s2 = await Artifact.list("sess-2");
      expect(s1).toHaveLength(1);
      expect(s1[0].id).toBe("art-1");
      expect(s2).toHaveLength(1);
      expect(s2[0].id).toBe("art-2");
    });
  });

  describe("versions", () => {
    it("returns the latest stored version", async () => {
      seedSession("sess-1");
      await Artifact.store("sess-1", makeMeta({ version: 1, title: "v1" }), "content-v1");
      await Artifact.store("sess-1", makeMeta({ version: 2, title: "v2" }), "content-v2");

      const vers = await Artifact.versions("art-1");
      expect(vers).toHaveLength(1);
      expect(vers[0].version).toBe(2);
      expect(vers[0].title).toBe("v2");
    });

    it("returns empty array for unknown artifact", async () => {
      const vers = await Artifact.versions("nonexistent");
      expect(vers).toHaveLength(0);
    });
  });
});
