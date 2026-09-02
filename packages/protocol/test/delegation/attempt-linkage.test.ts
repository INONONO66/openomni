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
    // #807: only a settlement citing recorded checks closes the attempt as a
    // success; the self-report terminal gets its own outcome.
    ["verified", "succeeded"],
    ["unverified", "unverified"],
  ] as const)("%s settles the attempt as %s", (settled, outcome) => {
    expect(Delegation.settlementToAttemptOutcome(settled)).toBe(outcome);
  });
});
