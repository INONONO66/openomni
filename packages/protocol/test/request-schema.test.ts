import { expect, test } from "bun:test";
import { canonicalDigest, SessionTransition } from "../src/index";

const original: SessionTransition.Request = {
  requestId: "intent", sessionId: "session", turnId: "turn", callId: "call",
  mode: "approval", parsedInput: { personId: "owner" }, inputHash: canonicalDigest({ personId: "owner" }),
  effectHash: canonicalDigest({ category: "authority" }), generation: 1, toolsGeneration: 1,
  toolsHash: "catalog", systemHash: "system", domainRevisions: { person: 4 }, deadline: 200,
  expectedResponders: ["owner"], correlation: {}, allowedActions: ["report_result"],
  bindingDigest: "binding", resolution: "first", threshold: 1, seenReplyIds: [], replies: [],
  state: "open", outcome: null, createdAt: 100,
};

test("a request preserves the original invocation and rejects incomplete or contradictory terminals", () => {
  expect(SessionTransition.Request.parse(original)).toEqual(original);
  for (const [state, outcome] of [
    ["resolved", "answered"], ["refused", "denied"], ["expired", "outcome_unknown"], ["cancelled", "cancelled"],
  ] as const) {
    expect(SessionTransition.Request.safeParse({ ...original, state, outcome }).success).toBe(true);
    expect(SessionTransition.Request.safeParse({ ...original, state }).success).toBe(false);
  }
  expect(SessionTransition.Request.safeParse({ ...original, state: "expired", outcome: "answered" }).success).toBe(false);
  expect(SessionTransition.Request.safeParse({ ...original, outcome: "answered" }).success).toBe(false);
  expect(SessionTransition.Request.safeParse({ ...original, inputHash: "" }).success).toBe(false);
});

test("request quorum and all bounds count distinct expected responders", () => {
  for (const resolution of ["quorum", "all"] as const) {
    expect(SessionTransition.Request.safeParse({ ...original, resolution, threshold: 2, expectedResponders: ["one", "two"] }).success).toBe(true);
    expect(SessionTransition.Request.safeParse({ ...original, resolution, threshold: 2, expectedResponders: ["one", "one"] }).success).toBe(false);
    expect(SessionTransition.Request.safeParse({ ...original, resolution, threshold: 3, expectedResponders: ["one", "two"] }).success).toBe(false);
  }
  expect(SessionTransition.Request.safeParse({ ...original, resolution: "all", threshold: 1, expectedResponders: ["one", "two"] }).success).toBe(false);
});
