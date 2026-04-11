import { describe, expect, it } from "bun:test";
import { BUILTIN_CATEGORIES } from "../../src/category";

const expectedNames = [
  "quick",
  "deep",
  "visual-engineering",
  "ultrabrain",
  "writing",
  "unspecified-high",
  "unspecified-low",
];

describe("BUILTIN_CATEGORIES", () => {
  it("includes all seven built-in categories", () => {
    expect(BUILTIN_CATEGORIES).toHaveLength(7);
    expect(BUILTIN_CATEGORIES.map((category) => category.name)).toEqual(expectedNames);
  });

  it("provides required fields for every category", () => {
    for (const category of BUILTIN_CATEGORIES) {
      expect(category.name.length).toBeGreaterThan(0);
      expect(category.description.length).toBeGreaterThan(0);
    }
  });
});
