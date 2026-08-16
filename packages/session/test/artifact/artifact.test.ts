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
});
