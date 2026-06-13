import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findUp } from "../../src/context/find-up";

let tempRoot: string;
let level0: string;
let level1: string;
let level2: string;
let level3: string;

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "find-up-test-")));
  level0 = tempRoot;
  level1 = join(level0, "level1");
  level2 = join(level1, "level2");
  level3 = join(level2, "level3");

  mkdirSync(level3, { recursive: true });

  writeFileSync(join(level0, "root.txt"), "root");
  writeFileSync(join(level2, "config.json"), "{}");
  writeFileSync(join(level3, "local.env"), "");
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("findUp", () => {
  it("finds file in start directory itself", () => {
    const result = findUp("root.txt", level0);
    expect(result).toBe(join(level0, "root.txt"));
  });

  it("finds file in parent directory (2 levels up)", () => {
    const result = findUp("config.json", level3);
    expect(result).toBe(join(level2, "config.json"));
  });

  it("finds file in grandparent directory (3 levels up)", () => {
    const result = findUp("root.txt", level3);
    expect(result).toBe(join(level0, "root.txt"));
  });

  it("returns undefined when file not found anywhere", () => {
    const result = findUp("nonexistent.txt", level3);
    expect(result).toBeUndefined();
  });

  it("respects max depth of 10 levels", () => {
    let deepDir = level3;
    for (let i = 0; i < 12; i++) {
      deepDir = join(deepDir, `deep${i}`);
      mkdirSync(deepDir, { recursive: true });
    }

    const result = findUp("config.json", deepDir);
    expect(result).toBeUndefined();
  });

  it("finds file within max depth boundary", () => {
    let deepDir = level3;
    for (let i = 0; i < 9; i++) {
      deepDir = join(deepDir, `boundary${i}`);
      mkdirSync(deepDir, { recursive: true });
    }

    writeFileSync(join(deepDir, "target.txt"), "found");
    const result = findUp("target.txt", deepDir);
    expect(result).toBe(join(deepDir, "target.txt"));
  });
});

describe("findUp caching", () => {
  it("returns cached result even after file is deleted", () => {
    const dir = join(tempRoot, "cache-test");
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "cached.txt");
    writeFileSync(filePath, "exists");

    const first = findUp("cached.txt", dir);
    expect(first).toBe(filePath);

    unlinkSync(filePath);

    const second = findUp("cached.txt", dir);
    expect(second).toBe(filePath);
  });

  it("caches undefined for missing files", () => {
    const dir = join(tempRoot, "cache-miss");
    mkdirSync(dir, { recursive: true });

    const first = findUp("nope.txt", dir);
    expect(first).toBeUndefined();

    writeFileSync(join(dir, "nope.txt"), "now exists");

    const second = findUp("nope.txt", dir);
    expect(second).toBeUndefined();
  });
});
