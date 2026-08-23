import { describe, expect, test } from "bun:test";
import { Tool } from "../src/tool/index.js";

describe("Tool.Placement", () => {
  test("the three placements parse and anything else is refused", () => {
    for (const placement of ["machine", "host", "free"] as const) {
      expect(Tool.Placement.safeParse(placement).success).toBe(true);
    }
    const bogus = Tool.Placement.safeParse("remote");
    expect(bogus.success).toBe(false);
    if (!bogus.success) {
      expect(bogus.error.issues[0]?.code).toBe("invalid_enum_value");
      expect(bogus.error.issues[0]?.path).toEqual([]);
    }
  });

  test("a legacy spec stays valid and placement stays absent — the catalog resolver owns the free default", () => {
    const legacy = Tool.Spec.safeParse({ name: "read", inputSchema: {} });
    expect(legacy.success).toBe(true);
    if (legacy.success) {
      expect(legacy.data.placement).toBeUndefined();
      expect(legacy.data.requires).toBeUndefined();
    }
  });

  test("requires speaks the capability grammar", () => {
    const result = Tool.Spec.safeParse({
      name: "x",
      inputSchema: {},
      requires: ["NotACapability"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        "capability id must be dot-namespaced lowercase (e.g. fs.read)",
      );
      expect(result.error.issues[0]?.path.join(".")).toBe("requires.0");
    }
  });

  test("a placed machine tool accepts placement + requires together", () => {
    expect(
      Tool.Spec.safeParse({
        name: "screen_read",
        inputSchema: {},
        placement: "machine",
        requires: ["screen.read"],
      }).success,
    ).toBe(true);
  });
});
