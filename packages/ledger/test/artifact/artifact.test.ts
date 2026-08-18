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
    it("stores and retrieves an artifact", () => {
      seedSession("sess-1");
      const meta = makeMeta();
      Artifact.store("sess-1", meta, "hello world");

      const result = Artifact.get("art-1");
      expect(result).not.toBeNull();
      expect(result?.meta.id).toBe("art-1");
      expect(result?.meta.title).toBe("output.txt");
      expect(result?.content).toBe("hello world");
    });

    it("returns null for missing artifact", () => {
      const result = Artifact.get("nonexistent");
      expect(result).toBeNull();
    });

    it("returns latest version on get", () => {
      seedSession("sess-1");
      const v1 = makeMeta({ version: 1 });
      const v2 = makeMeta({ version: 2, title: "output-v2.txt" });

      Artifact.store("sess-1", v1, "version 1 content");
      Artifact.store("sess-1", v2, "version 2 content");

      const result = Artifact.get("art-1");
      expect(result).not.toBeNull();
      expect(result?.meta.version).toBe(2);
      expect(result?.meta.title).toBe("output-v2.txt");
      expect(result?.content).toBe("version 2 content");
    });
  });

  describe("fail-closed", () => {
    const absentMessage = "does not implement artifact";

    it("store and get throw when the artifact sub-adapter is absent", () => {
      const bare = Storage.get();
      Storage.configure({
        transaction: bare.transaction.bind(bare),
        session: bare.session,
        message: bare.message,
        part: bare.part,
      });

      // Pre-fix behavior was `artifact?.store(...)`: a silent write no-op
      // indistinguishable from a persisted artifact. Both surfaces fail
      // closed now, like every other store in this package (#522).
      expect(() => Artifact.store("sess-1", makeMeta(), "content")).toThrow(absentMessage);
      expect(() => Artifact.get("art-1")).toThrow(absentMessage);
    });
  });
});
