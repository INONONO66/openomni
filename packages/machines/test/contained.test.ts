/**
 * #1312 — one export-root spelling and one containment predicate: a trailing
 * or doubled slash on the configured export must not change what the host
 * routes or the daemon executes.
 */
import { expect, test } from "bun:test";
import { isContained, normalizeExportRoot } from "../src/contained";

test("normalizeExportRoot folds trailing and doubled slashes, keeping the filesystem root", () => {
  expect(normalizeExportRoot("/tmp/x/")).toBe("/tmp/x");
  expect(normalizeExportRoot("/tmp//x")).toBe("/tmp/x");
  expect(normalizeExportRoot("/tmp/x//")).toBe("/tmp/x");
  expect(normalizeExportRoot("/")).toBe("/");
  expect(normalizeExportRoot("//")).toBe("/");
});

test("isContained is spelled the same for a trailing-slash, doubled-slash or bare root", () => {
  for (const root of ["/tmp/x", "/tmp/x/", "/tmp//x", "/tmp/x//"]) {
    expect(isContained(root, "/tmp/x")).toBe(true);
    expect(isContained(root, "/tmp/x/a/b")).toBe(true);
    expect(isContained(root, "/tmp/xy")).toBe(false);
    expect(isContained(root, "/tmp")).toBe(false);
  }
});

test("the filesystem root contains every absolute path", () => {
  expect(isContained("/", "/")).toBe(true);
  expect(isContained("/", "/etc/hosts")).toBe(true);
  expect(isContained("//", "/etc/hosts")).toBe(true);
});
