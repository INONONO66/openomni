import { expect, test } from "bun:test";
import { compilePolicySnapshot } from "../src/row-compiler";
import { atGeneration, compaction, draft } from "./row-fixtures";

const workerRule = {
  id: "worker-actor-deny",
  table: "B",
  sender: "session",
  senderRole: "worker",
  targetKind: "actor",
  check: { kind: "actor_send" },
  effect: "deny",
} as const;

test("message policy selects worker actor denial without matching external senders", () => {
  const policy = compilePolicySnapshot({
    generation: 1,
    rows: [
      atGeneration(compaction, 1),
      atGeneration(
        draft(
          workerRule.id,
          "message",
          "pre",
          { type: "deny", reason: "actor_send" },
          {
            match: { message: workerRule },
          },
        ),
        1,
      ),
    ],
  });
  const worker = policy.evaluate({
    kind: "message",
    phase: "pre",
    value: {},
    message: {
      sender: "session",
      senderRole: "worker",
      targetKind: "actor",
      type: "message",
      parentChild: false,
      fanout: 0,
      depth: 1,
      withinParentDeadline: true,
    },
  });
  const external = policy.evaluate({
    kind: "message",
    phase: "pre",
    value: {},
    message: {
      sender: "external",
      addressee: "bot",
      identity: true,
      grantTier: true,
      egressBudget: true,
      eventIdUnique: true,
      replyCorrelation: true,
    },
  });
  expect(worker.verdict).toBe("deny");
  expect(worker.matchedRuleIds).toEqual(["worker-actor-deny"]);
  expect(external.matchedRuleIds).toEqual([]);
});

test("send_message cannot bypass admission by omitting its authenticated context", () => {
  const policy = compilePolicySnapshot({ generation: 1, rows: [atGeneration(compaction, 1)] });
  expect(
    policy.evaluate({ kind: "message", phase: "pre", op: "send_message", value: {} }),
  ).toMatchObject({
    verdict: "deny",
    reason: "message_context_missing",
    matchedRuleIds: [],
  });
});

test("message post denial is rejected during compilation", () => {
  const rows = [
    atGeneration(compaction, 1),
    atGeneration(draft("late-denial", "message", "post", { type: "deny" }), 1),
  ];
  expect(() => compilePolicySnapshot({ generation: 1, rows })).toThrow(
    expect.objectContaining({ code: "invalid_verdict" }),
  );
});
