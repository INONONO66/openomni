import { describe, expect, test } from "bun:test";
import { Engagement } from "../../src/index.js";

const T0 = 1_700_000_000_000;

function opened(terms: Engagement.Terms = {}): Engagement.Record {
  return Engagement.open(
    {
      id: "eng-1",
      ownerSessionId: "ses-owner",
      title: "sell bike, floor 50000",
      terms,
    },
    T0,
  );
}

function move(
  record: Engagement.Record,
  to: Engagement.State,
  extra: Partial<Engagement.TransitionInput> = {},
): Engagement.Outcome {
  return Engagement.transition(record, {
    to,
    at: T0 + 1_000,
    reason: "test move",
    ...extra,
  });
}

function expectRecord(outcome: Engagement.Outcome): Engagement.Record {
  if (outcome.kind === "rejected") {
    throw new Error(`expected a state change, got rejection ${outcome.code}`);
  }
  return outcome.record;
}

describe("Engagement.open", () => {
  test("starts in planning with no waits at revision 1 (head === revision from birth)", () => {
    const record = opened();
    expect(record.state).toBe("planning");
    expect(record.openWaitIds).toEqual([]);
    expect(record.revision).toBe(1);
    expect(record.expiresAt).toBeUndefined();
    expect(record.createdAt).toBe(T0);
    expect(record.updatedAt).toBe(T0);
  });

  test("seeds expiresAt from terms.deadline", () => {
    const record = opened({ deadline: T0 + 60_000 });
    expect(record.expiresAt).toBe(T0 + 60_000);
  });
});

describe("Engagement.transition — legal edges", () => {
  test("walks the full §5 happy path to done", () => {
    let record = opened({ spendCeiling: 50_000 });

    record = expectRecord(
      move(record, "awaiting_external", { waitIds: ["wait-1"], validResponders: ["actor-buyer"] }),
    );
    expect(record.state).toBe("awaiting_external");
    expect(record.openWaitIds).toEqual(["wait-1"]);
    expect(record.validResponders).toEqual(["actor-buyer"]);
    expect(record.revision).toBe(2);

    record = expectRecord(move(record, "deliberating"));
    expect(record.state).toBe("deliberating");
    // Open-wait set persists until replaced — resumption bookkeeping, not dialogue.
    expect(record.openWaitIds).toEqual(["wait-1"]);

    record = expectRecord(move(record, "awaiting_user_approval"));
    record = expectRecord(move(record, "acting", { ownerApproved: true }));
    expect(record.state).toBe("acting");

    record = expectRecord(move(record, "done"));
    expect(record.state).toBe("done");
    expect(record.openWaitIds).toEqual([]);
    expect(Engagement.isTerminal(record.state)).toBe(true);
  });

  test("deliberating may act directly when no term crossing is reported", () => {
    let record = opened();
    record = expectRecord(move(record, "deliberating"));
    const outcome = move(record, "acting");
    expect(outcome.kind).toBe("transitioned");
  });

  test("awaiting_user_approval may fall back to deliberating (owner said no)", () => {
    let record = opened();
    record = expectRecord(move(record, "deliberating"));
    record = expectRecord(move(record, "awaiting_user_approval"));
    const outcome = move(record, "deliberating");
    expect(outcome.kind).toBe("transitioned");
  });

  test("abort is legal from every non-terminal state", () => {
    let record = opened();
    expect(move(record, "aborted").kind).toBe("transitioned");
    record = expectRecord(move(record, "deliberating"));
    const aborted = expectRecord(move(record, "aborted"));
    expect(aborted.state).toBe("aborted");
    expect(aborted.openWaitIds).toEqual([]);
  });
});

describe("Engagement.transition — rejections", () => {
  test("illegal edge is a typed rejection, record untouched", () => {
    const record = opened();
    const outcome = move(record, "acting");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.code).toBe("illegal_transition");
    expect(outcome.record.revision).toBe(1);
  });

  test("terminal record rejects every further transition", () => {
    let record = opened();
    record = expectRecord(move(record, "aborted"));
    const outcome = move(record, "deliberating");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.code).toBe("engagement_terminal");
  });

  test("acting from awaiting_user_approval demands the ownerApproved fact", () => {
    let record = opened();
    record = expectRecord(move(record, "deliberating"));
    record = expectRecord(move(record, "awaiting_user_approval"));
    const denied = move(record, "acting");
    expect(denied.kind).toBe("rejected");
    if (denied.kind !== "rejected") throw new Error("unreachable");
    expect(denied.code).toBe("approval_required");
    const deniedExplicit = move(record, "acting", { ownerApproved: false });
    expect(deniedExplicit.kind).toBe("rejected");
  });

  test("awaiting_external without waitIds is waits_required", () => {
    const record = opened();
    const outcome = move(record, "awaiting_external");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.code).toBe("waits_required");
  });

  test("expired and planning are never requestable targets", () => {
    expect(
      Engagement.TransitionInput.safeParse({ to: "expired", at: T0, reason: "r" }).success,
    ).toBe(false);
    expect(
      Engagement.TransitionInput.safeParse({ to: "planning", at: T0, reason: "r" }).success,
    ).toBe(false);
  });
});

describe("Engagement.transition — term crossing forces approval", () => {
  test("reported crossing overrides the requested target", () => {
    let record = opened({ spendCeiling: 50_000 });
    record = expectRecord(move(record, "deliberating"));
    const outcome = move(record, "acting", { termCrossed: true });
    expect(outcome.kind).toBe("forced_approval");
    if (outcome.kind !== "forced_approval") throw new Error("unreachable");
    expect(outcome.record.state).toBe("awaiting_user_approval");
    expect(outcome.requested).toBe("acting");
    expect(outcome.from).toBe("deliberating");
  });

  test("the fold records the report without evaluating terms (no ceiling needed)", () => {
    // termCrossed is an input FACT: forcing works even when no term exists —
    // the machine never checks money.
    let record = opened();
    record = expectRecord(move(record, "deliberating"));
    const outcome = move(record, "awaiting_external", { termCrossed: true, waitIds: ["w"] });
    expect(outcome.kind).toBe("forced_approval");
  });

  test("re-reporting a crossing at awaiting_user_approval has no edge", () => {
    let record = opened();
    record = expectRecord(move(record, "deliberating"));
    record = expectRecord(move(record, "awaiting_user_approval"));
    const outcome = move(record, "acting", { termCrossed: true });
    expect(outcome.kind).toBe("rejected");
  });
});

describe("Engagement deadline expiry", () => {
  test("transitions after the deadline are deadline_passed (abort excepted)", () => {
    const record = opened({ deadline: T0 + 500 });
    const outcome = move(record, "deliberating");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("unreachable");
    expect(outcome.code).toBe("deadline_passed");
    expect(move(record, "aborted").kind).toBe("transitioned");
  });

  test("expire folds to expired exactly once", () => {
    const record = opened({ deadline: T0 + 500 });
    const outcome = Engagement.expire(record, { at: T0 + 1_000 });
    expect(outcome.kind).toBe("expired");
    if (outcome.kind !== "expired") throw new Error("unreachable");
    expect(outcome.record.state).toBe("expired");
    expect(outcome.record.openWaitIds).toEqual([]);
    const again = Engagement.expire(outcome.record, { at: T0 + 2_000 });
    expect(again.kind).toBe("rejected");
    if (again.kind !== "rejected") throw new Error("unreachable");
    expect(again.code).toBe("engagement_terminal");
  });

  test("expire before the deadline (or without one) is not_expired", () => {
    const withDeadline = opened({ deadline: T0 + 500 });
    const early = Engagement.expire(withDeadline, { at: T0 + 100 });
    expect(early.kind).toBe("rejected");
    if (early.kind !== "rejected") throw new Error("unreachable");
    expect(early.code).toBe("not_expired");
    const without = Engagement.expire(opened(), { at: T0 + 100 });
    expect(without.kind).toBe("rejected");
    if (without.kind !== "rejected") throw new Error("unreachable");
    expect(without.code).toBe("not_expired");
  });
});
