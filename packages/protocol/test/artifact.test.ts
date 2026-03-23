import { describe, expect, it } from "bun:test";
import { Artifact } from "../src/artifact/index";

describe("Artifact schemas", () => {
  describe("Meta", () => {
    it("parses valid metadata", () => {
      const result = Artifact.Meta.parse({
        id: "art-1",
        sessionId: "sess-1",
        mimeType: "text/plain",
        title: "output.txt",
        version: 1,
        createdAt: "2025-01-01T00:00:00Z",
      });
      expect(result.id).toBe("art-1");
      expect(result.sessionId).toBe("sess-1");
      expect(result.mimeType).toBe("text/plain");
      expect(result.title).toBe("output.txt");
      expect(result.version).toBe(1);
    });

    it("defaults version to 1", () => {
      const result = Artifact.Meta.parse({
        id: "art-2",
        sessionId: "sess-1",
        mimeType: "application/json",
        title: "data.json",
        createdAt: "2025-01-01T00:00:00Z",
      });
      expect(result.version).toBe(1);
    });

    it("rejects missing required fields", () => {
      expect(() => Artifact.Meta.parse({})).toThrow();
      expect(() => Artifact.Meta.parse({ id: "art-1" })).toThrow();
    });

    it("rejects non-integer version", () => {
      expect(() =>
        Artifact.Meta.parse({
          id: "art-1",
          sessionId: "sess-1",
          mimeType: "text/plain",
          title: "file.txt",
          version: 1.5,
          createdAt: "2025-01-01T00:00:00Z",
        }),
      ).toThrow();
    });
  });

  describe("Part", () => {
    it("parses valid artifact part", () => {
      const result = Artifact.Part.parse({
        type: "artifact",
        artifactId: "art-1",
        meta: {
          id: "art-1",
          sessionId: "sess-1",
          mimeType: "text/html",
          title: "page.html",
          version: 2,
          createdAt: "2025-01-01T00:00:00Z",
        },
      });
      expect(result.type).toBe("artifact");
      expect(result.artifactId).toBe("art-1");
      expect(result.meta.version).toBe(2);
    });

    it("rejects wrong type literal", () => {
      expect(() =>
        Artifact.Part.parse({
          type: "text",
          artifactId: "art-1",
          meta: {
            id: "art-1",
            sessionId: "sess-1",
            mimeType: "text/plain",
            title: "file.txt",
            createdAt: "2025-01-01T00:00:00Z",
          },
        }),
      ).toThrow();
    });

    it("rejects missing artifactId", () => {
      expect(() =>
        Artifact.Part.parse({
          type: "artifact",
          meta: {
            id: "art-1",
            sessionId: "sess-1",
            mimeType: "text/plain",
            title: "file.txt",
            createdAt: "2025-01-01T00:00:00Z",
          },
        }),
      ).toThrow();
    });
  });
});
