import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceFileAtomically } from "../../src/index";

describe("replaceFileAtomically", () => {
  test("publishes exact bytes and removes its temporary file after replacement failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "openomni-atomic-file-"));
    const path = join(directory, "state.json");
    const fsync = spyOn(fs, "fsyncSync");
    try {
      writeFileSync(path, "previous\n");
      replaceFileAtomically(path, "replacement\n", {
        temporaryId: () => "success",
        durable: true,
      });
      expect(fsync).toHaveBeenCalledTimes(2);
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
      fsync.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
