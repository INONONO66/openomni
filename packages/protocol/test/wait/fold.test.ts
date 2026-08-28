import { describe, expect, test } from "bun:test";
import { Wait } from "../../src/wait/index.js";
import { buildReplyInput, buildWaitRecord } from "../helpers/wait.js";

describe("Wait fold — quorum resolution (threshold-of-expected)", () => {
  test("first of 2-of-3 attaches without resolving and advances revision once", () => {
    const record = buildWaitRecord();

    const outcome = Wait.attachReply(record, buildReplyInput());

    expect(outcome.kind).toBe("attached");
    if (outcome.kind !== "attached") throw new Error("expected attached");
    expect(outcome.responders).toBe(1);
    expect(outcome.threshold).toBe(2);
    expect(outcome.followUp).toBe(false);
    expect(outcome.record.status).toBe("open");
    expect(outcome.record.revision).toBe(record.revision + 1);
    expect(outcome.record.replies).toHaveLength(1);
    expect(outcome.reply.responderId).toBe("actor-a");
    expect(outcome.reply.receivedAt).toBe(1_000);
  });

  test("second distinct responder reaches the 2-of-3 threshold and resolves", () => {
    const first = Wait.attachReply(buildWaitRecord(), buildReplyInput());
    if (first.kind !== "attached") throw new Error("expected attached");

    const outcome = Wait.attachReply(
      first.record,
      buildReplyInput({ replyKey: "reply-key-2", responderCandidates: ["actor-b"], at: 2_000 }),
    );

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("expected resolved");
    expect(outcome.responders).toBe(2);
    expect(outcome.record.status).toBe("resolved");
    expect(outcome.record.partial).toBe(false);
    expect(outcome.record.resolvedAt).toBe(2_000);
    expect(outcome.record.revision).toBe(2);
  });

  test("first_reply policy resolves on the first valid reply", () => {
    const record = buildWaitRecord({ resolutionPolicy: "first_reply", quorum: undefined });

    const outcome = Wait.attachReply(record, buildReplyInput());

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("expected resolved");
    expect(outcome.threshold).toBe(1);
  });

  test("all policy resolves only when every expected responder replied", () => {
    let record = buildWaitRecord({ resolutionPolicy: "all", quorum: undefined });
    const responders = ["actor-a", "actor-b", "actor-c"];

    for (const [index, responder] of responders.entries()) {
      const outcome = Wait.attachReply(
        record,
        buildReplyInput({
          replyKey: `reply-key-${index}`,
          responderCandidates: [responder],
          at: 1_000 + index,
        }),
      );
      if (index < responders.length - 1) {
        expect(outcome.kind).toBe("attached");
      } else {
        expect(outcome.kind).toBe("resolved");
      }
      if (outcome.kind !== "attached" && outcome.kind !== "resolved") {
        throw new Error("expected attach path");
      }
      record = outcome.record;
    }
  });
});

describe("Wait fold — duplicate and responder identity rules", () => {
  test("same replyKey never advances quorum twice", () => {
    const first = Wait.attachReply(buildWaitRecord(), buildReplyInput());
    if (first.kind !== "attached") throw new Error("expected attached");

    const duplicate = Wait.attachReply(
      first.record,
      buildReplyInput({ responderCandidates: ["actor-b"], at: 2_000 }),
    );

    expect(duplicate.kind).toBe("rejected");
    if (duplicate.kind !== "rejected") throw new Error("expected rejected");
    expect(duplicate.code).toBe("duplicate_reply");
    // Unchanged record: same revision, quorum still needs a second responder.
    expect(duplicate.record.revision).toBe(first.record.revision);
    expect(duplicate.record.replies).toHaveLength(1);
    expect(duplicate.record.status).toBe("open");
  });

  test("duplicate replyKey on a RESOLVED wait short-circuits to already_resolved", () => {
    const record = buildWaitRecord({ resolutionPolicy: "first_reply", quorum: undefined });
    const resolved = Wait.attachReply(record, buildReplyInput());
    if (resolved.kind !== "resolved") throw new Error("expected resolved");

    // Channel redelivery of the resolving reply: the caller repeats the owner
    // delivery idempotently from this outcome — no state change, no revision bump.
    const redelivered = Wait.attachReply(resolved.record, buildReplyInput({ at: 1_100 }));

    expect(redelivered.kind).toBe("already_resolved");
    if (redelivered.kind !== "already_resolved") throw new Error("expected already_resolved");
    expect(redelivered.record).toEqual(resolved.record);
    expect(redelivered.reply).toEqual(resolved.reply);
  });

  test("duplicate replyKey on expired and cancelled waits keeps rejecting duplicate_reply", () => {
    const first = Wait.attachReply(buildWaitRecord(), buildReplyInput());
    if (first.kind !== "attached") throw new Error("expected attached");
    const expired = Wait.expire(first.record, { at: 10_001 });
    if (expired.kind !== "expired") throw new Error("expected expired");
    const cancelled = Wait.cancel(first.record, { at: 5_000 });
    if (cancelled.kind !== "cancelled") throw new Error("expected cancelled");

    for (const record of [expired.record, cancelled.record]) {
      const duplicate = Wait.attachReply(record, buildReplyInput({ at: 10_500 }));
      expect(duplicate.kind).toBe("rejected");
      if (duplicate.kind !== "rejected") throw new Error("expected rejected");
      expect(duplicate.code).toBe("duplicate_reply");
    }
  });

  test("a second reply from an already-counted responder attaches without advancing quorum", () => {
    const first = Wait.attachReply(buildWaitRecord(), buildReplyInput());
    if (first.kind !== "attached") throw new Error("expected attached");

    const again = Wait.attachReply(
      first.record,
      buildReplyInput({ replyKey: "reply-key-2", at: 2_000 }),
    );

    expect(again.kind).toBe("attached");
    if (again.kind !== "attached") throw new Error("expected attached");
    expect(again.responders).toBe(1);
    expect(again.record.status).toBe("open");
    expect(again.record.replies).toHaveLength(2);
  });

  test("a sender matching more than one expected responder is ambiguous, never guessed", () => {
    const record = buildWaitRecord();

    const outcome = Wait.attachReply(
      record,
      buildReplyInput({ responderCandidates: ["actor-a", "actor-b"] }),
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected rejected");
    expect(outcome.code).toBe("ambiguous_responder");
    expect(outcome.record.replies).toHaveLength(0);
    expect(outcome.record.revision).toBe(0);
  });

  test("a sender matching no expected responder is unknown", () => {
    const outcome = Wait.attachReply(
      buildWaitRecord(),
      buildReplyInput({ responderCandidates: ["actor-x"] }),
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected rejected");
    expect(outcome.code).toBe("unknown_responder");
  });

  test("a sender with zero matcher candidates is unknown — the fold owns the rule", () => {
    const outcome = Wait.attachReply(
      buildWaitRecord(),
      buildReplyInput({ responderCandidates: [] }),
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected rejected");
    expect(outcome.code).toBe("unknown_responder");
    expect(outcome.record.replies).toHaveLength(0);
  });
});

describe("Wait fold — delivery receipt", () => {
  test("recordDeliveryReceipt re-keys correlation.replyToMessageId and bumps the revision once", () => {
    const record = buildWaitRecord();

    const outcome = Wait.recordDeliveryReceipt(record, {
      externalMessageId: "platform:msg-1",
      at: 500,
    });

    expect(outcome.kind).toBe("delivery_recorded");
    if (outcome.kind !== "delivery_recorded") throw new Error("expected delivery_recorded");
    expect(outcome.externalMessageId).toBe("platform:msg-1");
    expect(outcome.record.correlation.replyToMessageId).toBe("platform:msg-1");
    // Every other correlation field is untouched — only the reply key moves.
    expect(outcome.record.correlation).toMatchObject({
      endpointId: "telegram:seller-1",
      channelId: "telegram:dm",
      tokenHash: "tok-1",
    });
    expect(outcome.record.revision).toBe(record.revision + 1);
    expect(outcome.record.updatedAt).toBe(500);
    expect(outcome.record.status).toBe("open");
  });

  test("a delivery receipt on a non-open wait is rejected as wait_terminal", () => {
    for (const status of ["resolved", "expired", "cancelled"] as const) {
      const record = buildWaitRecord({
        status,
        ...(status === "resolved" ? { resolvedAt: 900 } : {}),
        ...(status === "cancelled" ? { cancelledAt: 900 } : {}),
      });

      const outcome = Wait.recordDeliveryReceipt(record, {
        externalMessageId: "platform:msg-late",
        at: 1_000,
      });

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("expected rejected");
      expect(outcome.code).toBe("wait_terminal");
      expect(outcome.record).toEqual(record);
    }
  });
});

describe("Wait fold — expiry, cancellation, late replies", () => {
  test("2-of-3 with one reply expires partial: true", () => {
    const first = Wait.attachReply(buildWaitRecord(), buildReplyInput());
    if (first.kind !== "attached") throw new Error("expected attached");

    const outcome = Wait.expire(first.record, { at: 10_001 });

    expect(outcome.kind).toBe("expired");
    if (outcome.kind !== "expired") throw new Error("expected expired");
    expect(outcome.partial).toBe(true);
    expect(outcome.record.status).toBe("expired");
    expect(outcome.record.partial).toBe(true);
    expect(outcome.record.revision).toBe(2);
  });

  test("expiry with zero replies is not partial", () => {
    const outcome = Wait.expire(buildWaitRecord(), { at: 10_001 });

    expect(outcome.kind).toBe("expired");
    if (outcome.kind !== "expired") throw new Error("expected expired");
    expect(outcome.partial).toBe(false);
  });

  test("expire before the deadline is rejected as not_expired", () => {
    const outcome = Wait.expire(buildWaitRecord(), { at: 9_999 });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected rejected");
    expect(outcome.code).toBe("not_expired");
  });

  test("expire at the exact deadline is inclusive", () => {
    const outcome = Wait.expire(buildWaitRecord(), { at: 10_000 });

    expect(outcome.kind).toBe("expired");
  });

  test("expire and cancel on a terminal wait are rejected as wait_terminal", () => {
    const cancelled = Wait.cancel(buildWaitRecord(), { at: 500 });
    if (cancelled.kind !== "cancelled") throw new Error("expected cancelled");

    const expireAgain = Wait.expire(cancelled.record, { at: 10_001 });
    const cancelAgain = Wait.cancel(cancelled.record, { at: 600 });

    expect(expireAgain.kind).toBe("rejected");
    if (expireAgain.kind !== "rejected") throw new Error("expected rejected");
    expect(expireAgain.code).toBe("wait_terminal");
    expect(cancelAgain.kind).toBe("rejected");
    if (cancelAgain.kind !== "rejected") throw new Error("expected rejected");
    expect(cancelAgain.code).toBe("wait_terminal");
  });

  test("cancellation records cancelledAt and keeps attached replies", () => {
    const first = Wait.attachReply(buildWaitRecord(), buildReplyInput());
    if (first.kind !== "attached") throw new Error("expected attached");

    const outcome = Wait.cancel(first.record, { at: 3_000 });

    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind !== "cancelled") throw new Error("expected cancelled");
    expect(outcome.record.cancelledAt).toBe(3_000);
    expect(outcome.record.replies).toHaveLength(1);
  });

  test("a reply on an open wait at or past its deadline is rejected as deadline_passed", () => {
    for (const at of [10_000, 10_001]) {
      const outcome = Wait.attachReply(buildWaitRecord(), buildReplyInput({ at }));

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("expected rejected");
      expect(outcome.code).toBe("deadline_passed");
    }
  });

  test("a late reply inside the follow-up window attaches as supplementary information", () => {
    const record = buildWaitRecord({ resolutionPolicy: "first_reply", quorum: undefined });
    const resolved = Wait.attachReply(record, buildReplyInput());
    if (resolved.kind !== "resolved") throw new Error("expected resolved");

    const followUp = Wait.attachReply(
      resolved.record,
      buildReplyInput({ replyKey: "reply-key-2", responderCandidates: ["actor-b"], at: 1_900 }),
    );

    expect(followUp.kind).toBe("attached");
    if (followUp.kind !== "attached") throw new Error("expected attached");
    expect(followUp.followUp).toBe(true);
    expect(followUp.record.status).toBe("resolved");
    expect(followUp.record.replies).toHaveLength(2);
  });

  test("a reply after the follow-up window is rejected as late_reply", () => {
    const record = buildWaitRecord({ resolutionPolicy: "first_reply", quorum: undefined });
    const resolved = Wait.attachReply(record, buildReplyInput());
    if (resolved.kind !== "resolved") throw new Error("expected resolved");

    const late = Wait.attachReply(
      resolved.record,
      buildReplyInput({ replyKey: "reply-key-2", responderCandidates: ["actor-b"], at: 2_001 }),
    );

    expect(late.kind).toBe("rejected");
    if (late.kind !== "rejected") throw new Error("expected rejected");
    expect(late.code).toBe("late_reply");
  });

  test("replies to expired and cancelled waits are rejected as late_reply", () => {
    const expired = Wait.expire(buildWaitRecord(), { at: 10_001 });
    if (expired.kind !== "expired") throw new Error("expected expired");
    const cancelled = Wait.cancel(buildWaitRecord(), { at: 500 });
    if (cancelled.kind !== "cancelled") throw new Error("expected cancelled");

    for (const record of [expired.record, cancelled.record]) {
      const outcome = Wait.attachReply(record, buildReplyInput({ at: 10_500 }));
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") throw new Error("expected rejected");
      expect(outcome.code).toBe("late_reply");
    }
  });
});

describe("Wait schema — resolution coherence (owning layer for these rules)", () => {
  test("quorum policy without quorum bounds is rejected", () => {
    const result = Wait.Record.safeParse({
      ...buildWaitRecord(),
      quorum: undefined,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "resolutionPolicy quorum requires quorum bounds",
    );
  });

  test("quorum.expected must equal the expected responder count", () => {
    const result = Wait.Record.safeParse({
      ...buildWaitRecord(),
      quorum: { expected: 2, threshold: 2 },
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "quorum.expected must equal the expected responder count",
    );
  });

  test("quorum bounds without the quorum policy are rejected", () => {
    const result = Wait.Record.safeParse({
      ...buildWaitRecord(),
      resolutionPolicy: "all",
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "quorum bounds require resolutionPolicy quorum",
    );
  });

  test("duplicate expected responders are rejected", () => {
    const result = Wait.Record.safeParse({
      ...buildWaitRecord(),
      expectedResponders: ["actor-a", "actor-a", "actor-b"],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "expected responders must be unique",
    );
  });
});

describe("Wait.requestedWaitAction", () => {
  test("defaults an absent action to report_result", () => {
    expect(Wait.requestedWaitAction("plain text reply")).toBe("report_result");
    expect(Wait.requestedWaitAction(undefined)).toBe("report_result");
    expect(Wait.requestedWaitAction(null)).toBe("report_result");
    expect(Wait.requestedWaitAction({ output: "SN-A2334" })).toBe("report_result");
  });

  test("parses a valid enum member to itself", () => {
    expect(Wait.requestedWaitAction({ action: "report_result" })).toBe("report_result");
    expect(Wait.requestedWaitAction({ action: "ask_clarification" })).toBe("ask_clarification");
    expect(Wait.requestedWaitAction({ action: "attach_artifact" })).toBe("attach_artifact");
    expect(Wait.requestedWaitAction({ action: "decline_task" })).toBe("decline_task");
  });

  test("parses a present-but-invalid action to the typed sentinel, never the default", () => {
    expect(Wait.requestedWaitAction({ action: "unknown" })).toBe("invalid");
    expect(Wait.requestedWaitAction({ action: 42 })).toBe("invalid");
    expect(Wait.requestedWaitAction({ action: null })).toBe("invalid");
    expect(Wait.requestedWaitAction({ action: "REPORT_RESULT" })).toBe("invalid");
  });
});
