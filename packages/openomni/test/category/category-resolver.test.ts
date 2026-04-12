import { describe, expect, it } from "bun:test";
import type { CategoryConfig } from "../../src/category";
import { resolveCategory } from "../../src/category";

describe("resolveCategory", () => {
  it("resolves a built-in category", () => {
    const result = resolveCategory("deep");

    expect(result.source).toBe("builtin");
    expect(result.config.name).toBe("deep");
  });

  it("prefers custom categories over built-ins", () => {
    const custom: CategoryConfig[] = [
      {
        name: "quick",
        description: "custom quick",
        agentHints: ["oracle"],
      },
    ];

    const result = resolveCategory("quick", custom);

    expect(result.source).toBe("custom");
    expect(result.config.description).toBe("custom quick");
  });

  it("returns fallback when the category is unknown", () => {
    const result = resolveCategory("missing-category");

    expect(result.source).toBe("fallback");
    expect(result.config.name).toBe("unspecified-low");
  });

  it("handles an empty custom list", () => {
    const result = resolveCategory("writing", []);

    expect(result.source).toBe("builtin");
    expect(result.config.name).toBe("writing");
  });
});
