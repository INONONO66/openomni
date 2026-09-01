import { describe, expect, it } from "bun:test";
import { Conversation } from "../src/index";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;

function openRecord(policy?: Partial<Conversation.Policy>): Conversation.Record {
  return Conversation.open(
    {
      id: "conv-1",
      contactId: "actor-contact",
      endpointId: "endpoint-1",
      ownerRef: { kind: "session", id: "session-1" },
      openedBy: "resident",
      policy: {
        expiresAt: T0 + HOUR,
        maxOutbound: 2,
        maxInbound: 2,
        onInboundCapBreach: "demote",
        ...policy,
      },
    },
    T0,
  );
}

describe("Conversation.open", () => {
  it("mints an open window with zeroed counters and revision 1 (head === revision from birth)", () => {
    const record = openRecord();
    expect(record.state).toBe("open");
    expect(record.outboundUsed).toBe(0);
    expect(record.inboundUsed).toBe(0);
    expect(record.revision).toBe(1);
    expect(record.createdAt).toBe(T0);
    expect(record.closedBy).toBeUndefined();
  });
});

describe("Conversation.Record refinements", () => {
  it("rejects a closed record without a settlement", () => {
    const parsed = Conversation.Record.safeParse({ ...openRecord(), state: "closed" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an open record carrying a settlement", () => {
    const parsed = Conversation.Record.safeParse({
      ...openRecord(),
      closedBy: "owner",
      closedAt: T0,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("Conversation.close", () => {
  it("closes an open window with the recorded settlement", () => {
    const outcome = Conversation.close(openRecord(), "owner", T0 + 1);
    expect(outcome.kind).toBe("closed");
    expect(outcome.record.state).toBe("closed");
    expect(outcome.record.closedBy).toBe("owner");
    expect(outcome.record.closedAt).toBe(T0 + 1);
    expect(outcome.record.revision).toBe(2);
  });

  it("is idempotent and keeps the first settlement", () => {
    const closed = Conversation.close(openRecord(), "expiry", T0 + 1);
    const again = Conversation.close(closed.record, "owner", T0 + 2);
    expect(again.kind).toBe("unchanged");
    expect(again.record.closedBy).toBe("expiry");
    expect(again.record.revision).toBe(2);
  });
});

describe("Conversation.admitOutbound", () => {
  it("debits the outbound cap and advances the revision once", () => {
    const outcome = Conversation.admitOutbound(openRecord(), T0 + 1);
    expect(outcome.kind).toBe("admitted");
    if (outcome.kind !== "admitted") throw new Error("unreachable");
    expect(outcome.record.outboundUsed).toBe(1);
    expect(outcome.record.revision).toBe(2);
  });

  it("refuses on a closed window", () => {
    const closed = Conversation.close(openRecord(), "owner", T0).record;
    expect(Conversation.admitOutbound(closed, T0 + 1)).toEqual({
      kind: "refused",
      reason: "closed",
    });
  });

  it("refuses at and past expiry (inclusive boundary)", () => {
    expect(Conversation.admitOutbound(openRecord(), T0 + HOUR)).toEqual({
      kind: "refused",
      reason: "expired",
    });
  });

  it("refuses when the outbound cap is spent", () => {
    const first = Conversation.admitOutbound(openRecord(), T0 + 1);
    if (first.kind !== "admitted") throw new Error("unreachable");
    const second = Conversation.admitOutbound(first.record, T0 + 2);
    if (second.kind !== "admitted") throw new Error("unreachable");
    expect(Conversation.admitOutbound(second.record, T0 + 3)).toEqual({
      kind: "refused",
      reason: "outbound_cap",
    });
  });

  it("defers inside a same-day quiet-hours window", () => {
    const record = openRecord({ quietHours: { startMinute: 0, endMinute: 1439 } });
    expect(Conversation.admitOutbound(record, T0 + 1)).toEqual({
      kind: "refused",
      reason: "quiet_hours",
    });
  });

  it("admits outside a same-day quiet-hours window", () => {
    const minute = Math.floor((T0 + 1) / 60_000) % 1440;
    const record = openRecord({
      quietHours: { startMinute: (minute + 10) % 1440, endMinute: (minute + 20) % 1440 },
    });
    expect(Conversation.admitOutbound(record, T0 + 1).kind).toBe("admitted");
  });

  it("handles a quiet-hours window that wraps midnight", () => {
    // `at` = 00:30 UTC (minute-of-day 30). Policy expiry must stay ahead of it.
    const at = 30 * 60_000;
    const policy = { expiresAt: at + HOUR } as const;
    const wrapping = { startMinute: 1430, endMinute: 60 };
    expect(
      Conversation.admitOutbound(openRecord({ ...policy, quietHours: wrapping }), at),
    ).toEqual({ kind: "refused", reason: "quiet_hours" });
    const outside = { startMinute: 1435, endMinute: 20 };
    expect(
      Conversation.admitOutbound(openRecord({ ...policy, quietHours: outside }), at).kind,
    ).toBe("admitted");
  });
});

describe("Conversation.recordInbound", () => {
  it("counts inbound below the cap", () => {
    const outcome = Conversation.recordInbound(openRecord(), T0 + 1);
    expect(outcome.kind).toBe("recorded");
    expect(outcome.record.inboundUsed).toBe(1);
    expect(outcome.record.inboundCapBreachedAt).toBeUndefined();
  });

  it("reports the first cap crossing exactly once and keeps the window open", () => {
    const a = Conversation.recordInbound(openRecord(), T0 + 1);
    const b = Conversation.recordInbound(a.record, T0 + 2);
    const breach = Conversation.recordInbound(b.record, T0 + 3);
    expect(breach.kind).toBe("cap_breached");
    expect(breach.record.state).toBe("open");
    expect(breach.record.inboundCapBreachedAt).toBe(T0 + 3);
    const after = Conversation.recordInbound(breach.record, T0 + 4);
    expect(after.kind).toBe("already_breached");
    expect(after.record.inboundUsed).toBe(4);
    expect(after.record.inboundCapBreachedAt).toBe(T0 + 3);
  });
});

describe("Conversation events", () => {
  it("declares byte-frozen lifecycle event names", () => {
    expect(Conversation.Events.Opened.name).toBe("conversation.opened");
    expect(Conversation.Events.Closed.name).toBe("conversation.closed");
    expect(Conversation.Events.CapBreached.name).toBe("conversation.cap_breached");
  });
});

describe("Conversation.StoreError", () => {
  it("carries the typed code taxonomy", () => {
    const error = new Conversation.StoreError({
      message: "missing",
      code: "not_found",
      conversationId: "conv-1",
    });
    expect(error.name).toBe("ConversationStoreError");
    expect(error.data.code).toBe("not_found");
  });
});
