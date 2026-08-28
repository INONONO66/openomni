import { describe, expect, test } from "bun:test";
import { effectiveTrustTier } from "../../src/router/effective-tier.js";

describe("effectiveTrustTier", () => {
  test("keeps the actor trust tier over the channel default", () => {
    expect(effectiveTrustTier("manager", "observer")).toBe("manager");
  });

  test("uses the channel default when the actor has no trust tier", () => {
    expect(effectiveTrustTier(undefined, "observer")).toBe("observer");
  });

  test("refuses to resolve a tier when both are absent", () => {
    expect(effectiveTrustTier(undefined, undefined)).toBeUndefined();
  });
});
