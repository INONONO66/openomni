import { describe, expect, test } from "bun:test";
import { Artifact } from "../src/artifact/index";

const it = test;

describe("Artifact schemas", () => {
  describe("Meta", () => {
    it("round-trips valid metadata unchanged", () => {
      const meta = {
        id: "art-1",
        sessionId: "sess-1",
        mimeType: "text/plain",
        title: "output.txt",
        version: 1,
        createdAt: "2025-01-01T00:00:00Z",
      };
      expect(Artifact.Meta.parse(meta)).toEqual(meta);
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

    describe("version constraint", () => {
      for (const version of [0, -1, 1.5, Number.NaN]) {
        it(`rejects version ${String(version)}`, () =>
          expect(() =>
            Artifact.Meta.parse({
              id: "a",
              sessionId: "b",
              mimeType: "text/plain",
              title: "t",
              version,
              createdAt: "x",
            }),
          ).toThrow());
      }
    });

    describe("non-empty fields", () => {
      for (const createdAt of ["", "   "]) {
        it(`rejects createdAt ${JSON.stringify(createdAt)}`, () =>
          expect(() =>
            Artifact.Meta.parse({
              id: "a",
              sessionId: "b",
              mimeType: "text/plain",
              title: "t",
              createdAt,
            }),
          ).toThrow());
      }

      for (const mimeType of ["", "   "]) {
        it(`rejects mimeType ${JSON.stringify(mimeType)}`, () =>
          expect(() =>
            Artifact.Meta.parse({
              id: "a",
              sessionId: "b",
              mimeType,
              title: "t",
              createdAt: "x",
            }),
          ).toThrow());
      }
    });
  });
});
