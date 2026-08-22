import { describe, expect, it } from "bun:test";
import { Placement } from "@openomni/placement";
import type { RetryReason } from "../../src/core/retry";

/**
 * The cross-pin between the agent loop's retry vocabulary and placement's
 * advancing set (#752 review F2). Placement deliberately does not import the
 * loop, so the coupling is by declared string — THIS test is where a rename
 * on either side fails loudly instead of silently un-advancing the chain.
 */

// Compile-time pin, both directions: every member below IS a RetryReason
// (satisfies), and every RetryReason is listed (the Exclude check turns a
// missing member into a type error on the next line).
const ALL_RETRY_REASONS = [
  "timeout",
  "tool_error",
  "transient_error",
  "validation_error",
  "context_overflow",
] as const satisfies readonly RetryReason[];
const _everyReasonListed: [Exclude<RetryReason, (typeof ALL_RETRY_REASONS)[number]>] extends [
  never,
]
  ? true
  : never = true;
void _everyReasonListed;

describe("placement ↔ retry vocabulary cross-pin (#752)", () => {
  it("every advancing failure class is a real RetryReason string", () => {
    const known = new Set<string>(ALL_RETRY_REASONS);
    for (const reason of Placement.ADVANCING_FAILURES) {
      expect(known.has(reason)).toBe(true);
    }
  });

  it("the advancing set is exactly {timeout, transient_error, validation_error}", () => {
    expect([...Placement.ADVANCING_FAILURES].sort()).toEqual([
      "timeout",
      "transient_error",
      "validation_error",
    ]);
  });

  it("tool_error, context_overflow, and aborted never advance", () => {
    for (const reason of ["tool_error", "context_overflow", "aborted"]) {
      expect(Placement.ADVANCING_FAILURES.has(reason)).toBe(false);
    }
  });
});
