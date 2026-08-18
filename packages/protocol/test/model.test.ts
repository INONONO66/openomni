import { describe, expect, test } from "bun:test";
import { Model } from "../src/index";

// Kept from the retired agent.test.ts (#498 A3): the Model vocabulary is its
// own protocol surface and its coverage must not die with AgentProfile.
describe("Model protocol contracts", () => {
  test("accepts a standalone model ref", () => {
    expect(Model.Ref.parse({ provider: "openai", id: "gpt-4o" })).toEqual({
      provider: "openai",
      id: "gpt-4o",
    });
  });

  test("exposes shared model status values", () => {
    for (const status of ["alpha", "beta", "deprecated", "active"] as const) {
      expect(Model.Status.parse(status)).toBe(status);
    }
    expect(Model.Status.safeParse("unknown").success).toBe(false);
  });
});
