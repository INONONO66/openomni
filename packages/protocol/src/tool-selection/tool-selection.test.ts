import { expect, test, describe } from "bun:test";
import { ToolSelection } from "./index.js";

describe("ToolSelection", () => {
  describe("Category", () => {
    test("parses valid categories", () => {
      expect(ToolSelection.Category.parse("filesystem")).toBe("filesystem");
      expect(ToolSelection.Category.parse("execution")).toBe("execution");
      expect(ToolSelection.Category.parse("delegation")).toBe("delegation");
      expect(ToolSelection.Category.parse("mcp")).toBe("mcp");
      expect(ToolSelection.Category.parse("custom")).toBe("custom");
    });

    test("rejects invalid categories", () => {
      expect(() => ToolSelection.Category.parse("invalid")).toThrow();
      expect(() => ToolSelection.Category.parse("filesystem2")).toThrow();
    });
  });

  describe("Selection", () => {
    test("parses categories selection", () => {
      const input = { categories: ["filesystem", "execution"] };
      const parsed = ToolSelection.Selection.parse(input);
      expect(parsed.categories).toEqual(["filesystem", "execution"]);
      expect(parsed.all).toBeUndefined();
      expect(parsed.allow).toBeUndefined();
      expect(parsed.deny).toBeUndefined();
    });

    test("parses all with deny", () => {
      const input = { all: true, deny: ["bash"] };
      const parsed = ToolSelection.Selection.parse(input);
      expect(parsed.all).toBe(true);
      expect(parsed.deny).toEqual(["bash"]);
      expect(parsed.categories).toBeUndefined();
      expect(parsed.allow).toBeUndefined();
    });

    test("parses categories with allow", () => {
      const input = { categories: ["filesystem"], allow: ["dispatch"] };
      const parsed = ToolSelection.Selection.parse(input);
      expect(parsed.categories).toEqual(["filesystem"]);
      expect(parsed.allow).toEqual(["dispatch"]);
      expect(parsed.all).toBeUndefined();
      expect(parsed.deny).toBeUndefined();
    });

    test("round-trip parse: categories and execution", () => {
      const original = { categories: ["filesystem", "execution"] as const };
      const parsed = ToolSelection.Selection.parse(original);
      const stringified = JSON.stringify(parsed);
      const reparsed = ToolSelection.Selection.parse(JSON.parse(stringified));
      expect(reparsed.categories).toEqual(["filesystem", "execution"]);
    });

    test("round-trip parse: all with deny", () => {
      const original = { all: true, deny: ["bash", "rm"] };
      const parsed = ToolSelection.Selection.parse(original);
      const stringified = JSON.stringify(parsed);
      const reparsed = ToolSelection.Selection.parse(JSON.parse(stringified));
      expect(reparsed.all).toBe(true);
      expect(reparsed.deny).toEqual(["bash", "rm"]);
    });

    test("rejects invalid category in array", () => {
      const input = { categories: ["filesystem", "invalid"] };
      expect(() => ToolSelection.Selection.parse(input)).toThrow();
    });

    test("allows empty object", () => {
      const parsed = ToolSelection.Selection.parse({});
      expect(Object.keys(parsed).length).toBe(0);
    });
  });
});
