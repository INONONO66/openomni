import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFileAtomically } from "../../src/index";

describe("replaceFileAtomically", () => {
  test("publishes exact bytes and removes its temporary file after replacement failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-atomic-file-"));
    const path = join(directory, "state.json");
    try {
      writeFileSync(path, "previous\n");
      replaceFileAtomically(path, "replacement\n", { temporaryId: () => "success" });
      expect(readFileSync(path, "utf8")).toBe("replacement\n");
      expect(readdirSync(directory)).toEqual(["state.json"]);

      expect(() =>
        replaceFileAtomically(path, "partial\n", {
          temporaryId: () => "failure",
          replace: () => {
            throw new Error("injected replacement failure");
          },
        }),
      ).toThrow("injected replacement failure");
      expect(readFileSync(path, "utf8")).toBe("replacement\n");
      expect(readdirSync(directory)).toEqual(["state.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
