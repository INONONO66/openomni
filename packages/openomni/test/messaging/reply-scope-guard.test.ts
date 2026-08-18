import { describe, expect, test } from "bun:test";
import { resolveSenderTargetGrant } from "../../src/messaging/schema.js";

const claim = {
  senderId: "persona-1",
  targetActorId: "seller-1",
  operation: "awaited",
  at: 1_000,
} as const;

describe("resolveSenderTargetGrant — replyScope containment guard", () => {
  test("a scope-carrying (rule-materialized) instance is NOT resolvable here", () => {
    // This evaluator has no surface context, so it cannot check replyScope
    // containment — honoring the grant would silently void it (fail-closed;
    // the scope-aware gateway evaluator owns these from stage 2).
    const scoped = {
      id: "g-1",
      senderId: "persona-1",
      targetActorId: "seller-1",
      operations: ["awaited" as const],
      expiresAt: 2_000,
      ruleId: "r-1",
      replyScope: { surfaceKey: "junggonara:chat:777" },
    };
    expect(resolveSenderTargetGrant([scoped], claim)).toBeUndefined();
  });

  test("a standing grant without replyScope still resolves", () => {
    const standing = {
      id: "g-2",
      senderId: "persona-1",
      targetActorId: "seller-1",
      operations: ["awaited" as const],
    };
    expect(resolveSenderTargetGrant([standing], claim)?.id).toBe("g-2");
  });
});
