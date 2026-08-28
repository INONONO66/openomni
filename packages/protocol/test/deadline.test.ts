import { describe, expect, test } from "bun:test";
import { Deadline } from "../src/index.js";

describe("Deadline semantics", () => {
  test("a deadline expires at exact equality", () => {
    expect(Deadline.isExpired(9_999, 10_000)).toBe(false);
    expect(Deadline.isExpired(10_000, 10_000)).toBe(true);
    expect(Deadline.isExpired(10_001, 10_000)).toBe(true);
  });

  test("an effective deadline is clamped to the earlier parent or request", () => {
    expect(Deadline.clampToParent(9_000, 4_000)).toBe(4_000);
    expect(Deadline.clampToParent(4_000, 9_000)).toBe(4_000);
    expect(Deadline.clampToParent(4_000, 4_000)).toBe(4_000);
  });
});
