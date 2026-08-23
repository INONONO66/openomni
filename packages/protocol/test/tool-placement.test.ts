import { describe, expect, test } from "bun:test";
import { Tool } from "../src/tool/index.js";

describe("Tool.Placement", () => {
  test("the three placements parse and anything else is refused", () => {
    for (const placement of ["machine", "host", "free"] as const) {
      expect(Tool.Placement.parse(placement)).toBe(placement);
    }
    expect(Tool.Placement.safeParse("remote").success).toBe(false);
  });

  test("Spec accepts placement + requires additively and old specs stay valid", () => {
    const legacy = Tool.Spec.parse({ name: "read", inputSchema: {} });
    expect(legacy.placement).toBeUndefined();

    const placed = Tool.Spec.parse({
      name: "screen_read",
      inputSchema: {},
      placement: "machine",
      requires: ["screen.read"],
    });
    expect(placed.placement).toBe("machine");
    expect(placed.requires).toEqual(["screen.read"]);
  });

  test("requires speaks the capability grammar", () => {
    expect(
      Tool.Spec.safeParse({ name: "x", inputSchema: {}, requires: ["NotACapability"] }).success,
    ).toBe(false);
  });
});
