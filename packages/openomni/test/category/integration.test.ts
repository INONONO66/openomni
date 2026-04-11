import { describe, expect, it } from "bun:test";
import { resolveCategory } from "../../src/category";

describe("category module integration", () => {
  it("marks quick as a builtin resolution", () => {
    const result = resolveCategory("quick");

    expect(result.source).toBe("builtin");
    expect(result.config.name).toBe("quick");
  });

  it("marks unknown categories as fallback resolutions", () => {
    const result = resolveCategory("unknown");

    expect(result.source).toBe("fallback");
    expect(result.config.name).toBe("unspecified-low");
  });
});
