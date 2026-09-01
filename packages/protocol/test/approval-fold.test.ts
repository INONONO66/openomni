import { describe, expect, test } from "bun:test";
import { Approval } from "../src/index";

const T0 = 1_000;
const DEADLINE = 10_000;

const promotion: Approval.Subject = { kind: "contact_promotion", actorId: "actor-1" };
const merge: Approval.Subject = {
  kind: "endpoint_merge",
  endpointId: "endpoint-1",
  fromActorId: "actor-1",
  toActorId: "actor-2",
};

function pending(subject: Approval.Subject = promotion): Approval.Record {
  return Approval.request({ id: "approval-1", subject, deadline: DEADLINE }, T0);
}

describe("Approval fold", () => {
  test("request opens a pending record at revision 1 with no settlement", () => {
    const record = pending(merge);
    expect(record).toMatchObject({
      id: "approval-1",
      subject: merge,
      requestedBy: "resident",
      state: "pending",
      revision: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(record.decidedBy).toBeUndefined();
    expect(record.decidedAt).toBeUndefined();
  });

  test("the Owner's timely answer settles the request either way", () => {
    const approved = Approval.decide(pending(), "approved", T0 + 1);
    expect(approved.kind).toBe("decided");
    expect(approved.record).toMatchObject({
      state: "approved",
      decidedBy: "owner",
      decidedAt: T0 + 1,
      revision: 2,
    });

    const refused = Approval.decide(pending(), "refused", T0 + 1);
    expect(refused.record).toMatchObject({ state: "refused", decidedBy: "owner" });
  });

  test("an answer at or past the deadline records the deadline's refusal, never an approval", () => {
    const atDeadline = Approval.decide(pending(), "approved", DEADLINE);
    expect(atDeadline.record).toMatchObject({ state: "refused", decidedBy: "deadline" });

    const after = Approval.decide(pending(), "refused", DEADLINE + 5);
    expect(after.record).toMatchObject({ state: "refused", decidedBy: "deadline" });
  });

  test("deciding a settled request keeps the first recorded settlement", () => {
    const first = Approval.decide(pending(), "approved", T0 + 1);
    if (first.kind !== "decided") throw new Error("expected a decided outcome");
    const second = Approval.decide(first.record, "refused", T0 + 2);
    expect(second.kind).toBe("unchanged");
    expect(second.record).toMatchObject({ state: "approved", revision: 2 });
  });

  test("decision reads an unanswered request past its deadline as refused (fail-closed)", () => {
    const record = pending();
    expect(Approval.decision(record, DEADLINE - 1)).toBe("pending");
    expect(Approval.decision(record, DEADLINE)).toBe("refused");

    const approved = Approval.decide(record, "approved", T0 + 1);
    if (approved.kind !== "decided") throw new Error("expected a decided outcome");
    // A recorded settlement is final; the deadline no longer reinterprets it.
    expect(Approval.decision(approved.record, DEADLINE + 5)).toBe("approved");
  });

  test("the record schema rejects dishonest settlements", () => {
    const base = pending();
    expect(() =>
      Approval.Record.parse({ ...base, state: "approved", revision: 2 }),
    ).toThrow(/must record its settlement/);
    expect(() =>
      Approval.Record.parse({ ...base, decidedBy: "owner", decidedAt: T0 }),
    ).toThrow(/pending Approval cannot carry a settlement/);
    expect(() =>
      Approval.Record.parse({
        ...base,
        state: "approved",
        decidedBy: "deadline",
        decidedAt: DEADLINE,
        revision: 2,
      }),
    ).toThrow(/deadline can only refuse/);
  });
});
