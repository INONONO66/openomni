import { describe, expect, test } from "bun:test";
import { Delegation } from "../../src/index.js";

describe("Delegation.settlementToAttemptOutcome", () => {
  test.each([
    ["completed", "succeeded"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["delivery_failed", "interrupted"],
    ["no_response", "interrupted"],
    ["interrupted", "interrupted"],
  ] as const)("%s settles the attempt as %s", (settled, outcome) => {
    expect(Delegation.settlementToAttemptOutcome(settled)).toBe(outcome);
  });
});
