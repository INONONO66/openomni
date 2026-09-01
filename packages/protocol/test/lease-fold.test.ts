import { describe, expect, test } from "bun:test";
import { Lease } from "../src/index";

const T0 = 1_000;

function buildCreate(overrides: Partial<Lease.Create> = {}): Lease.Create {
  return {
    id: "lease-1",
    conversationId: "conv-1",
    holderDelegationId: "delegation-1",
    contactId: "alice",
    maxOutbound: 2,
    expiresAt: 100_000,
    ...overrides,
  };
}

describe("Lease fold", () => {
  test("issue mints a live record at revision 1 with zero spend", () => {
    const record = Lease.issue(buildCreate(), T0);
    expect(record).toMatchObject({
      id: "lease-1",
      state: "live",
      budget: { maxOutbound: 2, outboundUsed: 0 },
      revision: 1,
      createdAt: T0,
      updatedAt: T0,
    });
  });

  test("the record schema refuses an incoherent settlement", () => {
    const live = Lease.issue(buildCreate(), T0);
    expect(
      Lease.Record.safeParse({ ...live, state: "closed" }).success,
    ).toBe(false);
    expect(
      Lease.Record.safeParse({ ...live, closedBy: "owner", closedAt: T0 }).success,
    ).toBe(false);
    expect(
      Lease.Record.safeParse({
        ...live,
        budget: { maxOutbound: 1, outboundUsed: 2 },
      }).success,
    ).toBe(false);
  });

  test("close is idempotent and keeps the first settlement", () => {
    const live = Lease.issue(buildCreate(), T0);
    const closed = Lease.close(live, "settled", T0 + 1);
    expect(closed.kind).toBe("closed");
    if (closed.kind !== "closed") throw new Error("expected closed");
    expect(closed.record.revision).toBe(2);

    const again = Lease.close(closed.record, "owner", T0 + 2);
    expect(again.kind).toBe("unchanged");
    expect(again.record.closedBy).toBe("settled");
    expect(again.record.revision).toBe(2);
  });

  test("debit spends the carved allocation once per call", () => {
    const live = Lease.issue(buildCreate(), T0);
    const first = Lease.debit(live, T0 + 1);
    expect(first.kind).toBe("debited");
    if (first.kind !== "debited") throw new Error("expected debited");
    expect(first.record.budget.outboundUsed).toBe(1);
    expect(first.record.revision).toBe(2);

    const second = Lease.debit(first.record, T0 + 2);
    expect(second.kind).toBe("debited");
    if (second.kind !== "debited") throw new Error("expected debited");
    expect(second.record.budget.outboundUsed).toBe(2);

    const third = Lease.debit(second.record, T0 + 3);
    expect(third).toEqual({ kind: "refused", reason: "budget_exhausted" });
  });

  test("debit refuses a dead lease", () => {
    const live = Lease.issue(buildCreate(), T0);
    const closed = Lease.close(live, "cancelled", T0 + 1);
    expect(Lease.debit(closed.record, T0 + 2)).toEqual({
      kind: "refused",
      reason: "closed",
    });
  });

  test("debit refuses at the expiry boundary (inclusive)", () => {
    const live = Lease.issue(buildCreate(), T0);
    expect(Lease.debit(live, 99_999).kind).toBe("debited");
    expect(Lease.debit(live, 100_000)).toEqual({ kind: "refused", reason: "expired" });
  });

  test("the store error taxonomy is typed and serializable", () => {
    const error = new Lease.StoreError({
      message: "carve would exceed the conversation cap",
      code: "carve_exceeded",
      leaseId: "lease-1",
    });
    expect(Lease.StoreError.isInstance(error)).toBe(true);
    expect(error.data.code).toBe("carve_exceeded");
    expect(Lease.StoreError.Schema.safeParse(error.toObject()).success).toBe(true);
  });

  test("event schemas require the caller's trace", () => {
    const base = {
      leaseId: "lease-1",
      conversationId: "conv-1",
      holderDelegationId: "delegation-1",
      time: T0,
    };
    expect(Lease.Events.Issued.schema.safeParse(base).success).toBe(false);
    expect(
      Lease.Events.Closed.schema.safeParse({ ...base, traceId: "t", closedBy: "settled" }).success,
    ).toBe(true);
  });
});
