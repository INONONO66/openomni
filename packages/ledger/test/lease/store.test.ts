import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Lease } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { ConversationStore, LeaseStore, Storage } from "../../src/index";

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

const T0 = 1_000;

function openConversation(maxOutbound = 4, expiresAt = 100_000): void {
  ConversationStore.open(
    {
      id: "conv-1",
      contactId: "alice",
      endpointId: "ws:alice",
      ownerRef: { kind: "session", id: "session-1" },
      openedBy: "resident",
      policy: { expiresAt, maxOutbound, maxInbound: 32, onInboundCapBreach: "demote" },
    },
    "trace-conv",
    T0,
  );
}

function buildIssue(overrides: Partial<Parameters<typeof LeaseStore.issue>[0]> = {}) {
  return {
    id: "lease-1",
    conversationId: "conv-1",
    holderDelegationId: "delegation-1",
    delegationDeadline: 50_000,
    maxOutbound: 2,
    ...overrides,
  };
}

function captureStoreError(fn: () => unknown): InstanceType<typeof Lease.StoreError> {
  try {
    fn();
  } catch (error) {
    if (Lease.StoreError.isInstance(error)) return error;
    throw error;
  }
  throw new Error("expected LeaseStoreError, but nothing was thrown");
}

function ownerFacts(leaseId: string) {
  const ledger = Storage.get().ledger;
  if (!ledger) throw new Error("ledger sub-adapter missing");
  return ["lease.issued", "lease.debited", "lease.closed"]
    .flatMap((type) => ledger.factsByType(type))
    .filter((fact) => fact.streamId === `lease:${leaseId}`)
    .sort((a, b) => a.seq - b.seq);
}

describe("LeaseStore", () => {
  test("issue derives contact and expiry from the conversation and the deadline", () => {
    openConversation();
    const record = LeaseStore.issue(buildIssue(), "trace-issue", T0);
    expect(record).toMatchObject({
      contactId: "alice",
      expiresAt: 50_000,
      state: "live",
      revision: 1,
    });
    expect(ownerFacts("lease-1").map(({ seq, type }) => [seq, type])).toEqual([
      [1, "lease.issued"],
    ]);
  });

  test("issue expires at the conversation expiry when it is earlier than the deadline", () => {
    openConversation(4, 40_000);
    const record = LeaseStore.issue(buildIssue(), "trace-issue", T0);
    expect(record.expiresAt).toBe(40_000);
  });

  test("issue into a missing or closed conversation fails closed", () => {
    const missing = captureStoreError(() => LeaseStore.issue(buildIssue(), "trace", T0));
    expect(missing.data.code).toBe("conversation_closed");

    openConversation();
    ConversationStore.close("conv-1", "owner", "trace-close", T0);
    const closed = captureStoreError(() => LeaseStore.issue(buildIssue(), "trace", T0));
    expect(closed.data.code).toBe("conversation_closed");
  });

  test("the carve bound sums live allocations against the window cap, fail-closed", () => {
    openConversation(4);
    LeaseStore.issue(buildIssue(), "trace-1", T0);
    LeaseStore.issue(buildIssue({ id: "lease-2", holderDelegationId: "delegation-2" }), "t2", T0);
    // 2 + 2 reserved of 4; one more allocation of 1 must refuse.
    const exceeded = captureStoreError(() =>
      LeaseStore.issue(
        buildIssue({ id: "lease-3", holderDelegationId: "delegation-3", maxOutbound: 1 }),
        "t3",
        T0,
      ),
    );
    expect(exceeded.data.code).toBe("carve_exceeded");

    // A closed lease frees its allocation.
    LeaseStore.close("lease-2", "settled", "t4", T0);
    const after = LeaseStore.issue(
      buildIssue({ id: "lease-3", holderDelegationId: "delegation-3", maxOutbound: 1 }),
      "t5",
      T0,
    );
    expect(after.state).toBe("live");
  });

  test("spent outbound counts against the carve bound", () => {
    openConversation(2);
    ConversationStore.admitOutbound("conv-1", "trace-owner-send", T0);
    const exceeded = captureStoreError(() =>
      LeaseStore.issue(buildIssue({ maxOutbound: 2 }), "trace", T0),
    );
    expect(exceeded.data.code).toBe("carve_exceeded");
  });

  test("duplicate issue fails closed with a typed duplicate error", () => {
    openConversation();
    LeaseStore.issue(buildIssue(), "trace-1", T0);
    const error = captureStoreError(() => LeaseStore.issue(buildIssue(), "trace-2", T0));
    expect(error.data.code).toBe("duplicate");
    expect(ownerFacts("lease-1")).toHaveLength(1);
  });

  test("sendDebit debits the lease and the conversation atomically", () => {
    openConversation();
    LeaseStore.issue(buildIssue(), "trace-issue", T0);

    const outcome = LeaseStore.sendDebit("lease-1", T0 + 1);

    expect(outcome.kind).toBe("debited");
    expect(LeaseStore.get("lease-1")?.budget.outboundUsed).toBe(1);
    expect(ConversationStore.get("conv-1")?.outboundUsed).toBe(1);
    expect(ownerFacts("lease-1").map(({ seq, type }) => [seq, type])).toEqual([
      [1, "lease.issued"],
      [2, "lease.debited"],
    ]);
  });

  test("sendDebit refuses a spent lease and a dead lease without touching the conversation", () => {
    openConversation();
    LeaseStore.issue(buildIssue({ maxOutbound: 1 }), "trace-issue", T0);
    expect(LeaseStore.sendDebit("lease-1", T0).kind).toBe("debited");

    const spent = LeaseStore.sendDebit("lease-1", T0 + 1);
    expect(spent).toEqual({ kind: "refused", reason: "budget_exhausted" });
    expect(ConversationStore.get("conv-1")?.outboundUsed).toBe(1);

    LeaseStore.close("lease-1", "settled", "t3", T0 + 2);
    const dead = LeaseStore.sendDebit("lease-1", T0 + 3);
    expect(dead).toEqual({ kind: "refused", reason: "closed" });
    expect(ConversationStore.get("conv-1")?.outboundUsed).toBe(1);
  });

  test("a conversation refusal inside sendDebit writes nothing on either side", () => {
    openConversation(1);
    // The owner spends the window's one outbound slot; the lease carve of 1
    // was reserved while 1 remained... open a fresh window instead: cap 2,
    // lease 1, owner spends 1, lease sends 1 (window full), lease sends again.
    ConversationStore.open(
      {
        id: "conv-2",
        contactId: "bob",
        endpointId: "ws:bob",
        ownerRef: { kind: "session", id: "session-1" },
        openedBy: "resident",
        policy: { expiresAt: 100_000, maxOutbound: 2, maxInbound: 32, onInboundCapBreach: "demote" },
      },
      "trace-conv-2",
      T0,
    );
    LeaseStore.issue(
      buildIssue({ id: "lease-2", conversationId: "conv-2", maxOutbound: 2 }),
      "trace-issue-2",
      T0,
    );
    ConversationStore.admitOutbound("conv-2", "trace-owner", T0);
    expect(LeaseStore.sendDebit("lease-2", T0).kind).toBe("debited");
    const refused = LeaseStore.sendDebit("lease-2", T0 + 1);
    expect(refused).toEqual({ kind: "refused", reason: "conversation_outbound_cap" });
    expect(LeaseStore.get("lease-2")?.budget.outboundUsed).toBe(1);
    expect(ConversationStore.get("conv-2")?.outboundUsed).toBe(2);
  });

  test("close is idempotent and closeByHolder/closeByConversation kill live leases", async () => {
    openConversation(8);
    LeaseStore.issue(buildIssue(), "t1", T0);
    LeaseStore.issue(buildIssue({ id: "lease-2", holderDelegationId: "delegation-1" }), "t2", T0);
    LeaseStore.issue(buildIssue({ id: "lease-3", holderDelegationId: "delegation-3" }), "t3", T0);
    const events: string[] = [];
    Bus.observe((event) => {
      if (event.name === "lease.closed") events.push(event.name);
    });

    expect(LeaseStore.closeByHolder("delegation-1", "settled", "t4", T0 + 1)).toBe(2);
    expect(LeaseStore.get("lease-1")?.closedBy).toBe("settled");
    expect(LeaseStore.get("lease-2")?.closedBy).toBe("settled");
    expect(LeaseStore.get("lease-3")?.state).toBe("live");

    const again = LeaseStore.close("lease-1", "owner", "t5", T0 + 2);
    expect(again.kind).toBe("unchanged");
    expect(again.record.closedBy).toBe("settled");

    expect(LeaseStore.closeByConversation("conv-1", "conversation_revoked", "t6", T0 + 3)).toBe(1);
    expect(LeaseStore.get("lease-3")?.closedBy).toBe("conversation_revoked");

    await flushBus();
    expect(events).toHaveLength(3);
  });

  test("list and the live indexes read back what the folds wrote", () => {
    openConversation(8);
    LeaseStore.issue(buildIssue(), "t1", T0);
    LeaseStore.issue(buildIssue({ id: "lease-2", holderDelegationId: "delegation-2" }), "t2", T0);
    LeaseStore.close("lease-2", "owner", "t3", T0 + 1);

    expect(LeaseStore.list().map((lease) => lease.id).sort()).toEqual(["lease-1", "lease-2"]);
    expect(LeaseStore.list(["closed"]).map((lease) => lease.id)).toEqual(["lease-2"]);
    expect(
      LeaseStore.listLiveByConversation("conv-1", T0 + 2).map((lease) => lease.id),
    ).toEqual(["lease-1"]);
    expect(
      LeaseStore.listLiveByHolder("delegation-1", T0 + 2).map((lease) => lease.id),
    ).toEqual(["lease-1"]);
    // Past its expiry the live index no longer serves the lease.
    expect(LeaseStore.listLiveByHolder("delegation-1", 60_000)).toEqual([]);
  });

  test("an adapter without the conversation or ledger surface fails closed on issue", () => {
    openConversation();
    const adapter = Storage.get();
    Storage.reset();
    Storage.configure({ ...adapter, conversation: undefined } as unknown as Storage.Adapter);
    const missingConversation = captureStoreError(() =>
      LeaseStore.issue(buildIssue(), "trace", T0),
    );
    expect(missingConversation.data.code).toBe("adapter_absent");

    Storage.reset();
    Storage.configure({ ...adapter, ledger: undefined } as unknown as Storage.Adapter);
    const missingLedger = captureStoreError(() => LeaseStore.issue(buildIssue(), "trace", T0));
    expect(missingLedger.data.code).toBe("adapter_absent");
  });

  test("SQLITE_BUSY at the transaction entry surfaces as typed unavailable", () => {
    openConversation();
    const adapter = Storage.get();
    const original = adapter.transaction.bind(adapter);
    Object.defineProperty(adapter, "transaction", {
      configurable: true,
      value: () => {
        const busy = new Error("database is locked") as Error & { code: string; errno: number };
        busy.code = "SQLITE_BUSY";
        busy.errno = 5;
        throw busy;
      },
    });
    try {
      const error = captureStoreError(() => LeaseStore.issue(buildIssue(), "trace", T0));
      expect(error.data.code).toBe("unavailable");
    } finally {
      Object.defineProperty(adapter, "transaction", { configurable: true, value: original });
    }
  });

  test("a transaction that lands nothing surfaces as typed unavailable, not silence", () => {
    openConversation();
    LeaseStore.issue(buildIssue(), "t1", T0);
    const adapter = Storage.get();
    const original = adapter.transaction.bind(adapter);
    Object.defineProperty(adapter, "transaction", {
      configurable: true,
      value: () => undefined,
    });
    try {
      const issueError = captureStoreError(() =>
        LeaseStore.issue(buildIssue({ id: "lease-2", holderDelegationId: "d2" }), "t2", T0),
      );
      expect(issueError.data.code).toBe("unavailable");
      const debitError = captureStoreError(() => LeaseStore.sendDebit("lease-1", T0 + 1));
      expect(debitError.data.code).toBe("unavailable");
    } finally {
      Object.defineProperty(adapter, "transaction", { configurable: true, value: original });
    }
  });

  test("a head moved outside the store fails every transition closed (revision_conflict)", () => {
    openConversation(8);
    LeaseStore.issue(buildIssue(), "t1", T0);
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    // Move the lease stream head past the projected revision outside the store.
    const appended = ledger.append(
      { streamId: "lease:lease-1", type: "lease.debited", data: {} },
      1,
    );
    expect(appended.kind).toBe("appended");
    const debitError = captureStoreError(() => LeaseStore.sendDebit("lease-1", T0 + 1));
    expect(debitError.data.code).toBe("revision_conflict");
    const closeError = captureStoreError(() => LeaseStore.close("lease-1", "owner", "t2", T0 + 2));
    expect(closeError.data.code).toBe("revision_conflict");
  });

  test("a conversation head moved outside the store fails the dual debit closed", () => {
    openConversation(8);
    LeaseStore.issue(buildIssue(), "t1", T0);
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    // conversation:conv-1 head is 1 (opened); move it ahead so the debit's
    // conversation append conflicts AFTER the lease append succeeded — the
    // transaction rolls the lease fact back with it.
    const appended = ledger.append(
      { streamId: "conversation:conv-1", type: "conversation.inbound_recorded", data: {} },
      1,
    );
    expect(appended.kind).toBe("appended");
    const debitError = captureStoreError(() => LeaseStore.sendDebit("lease-1", T0 + 1));
    expect(debitError.data.code).toBe("revision_conflict");
    expect(LeaseStore.get("lease-1")?.budget.outboundUsed).toBe(0);
    expect(ownerFacts("lease-1")).toHaveLength(1);
  });

  test("a projection CAS that loses the race fails closed (revision_conflict)", () => {
    openConversation(8);
    LeaseStore.issue(buildIssue(), "t1", T0);
    const sub = Storage.get().lease;
    if (!sub) throw new Error("lease sub-adapter missing");
    const original = sub.compareAndSet.bind(sub);
    Object.defineProperty(sub, "compareAndSet", {
      configurable: true,
      value: () => false,
    });
    try {
      const error = captureStoreError(() => LeaseStore.sendDebit("lease-1", T0 + 1));
      expect(error.data.code).toBe("revision_conflict");
      const closeError = captureStoreError(() =>
        LeaseStore.close("lease-1", "owner", "t2", T0 + 2),
      );
      expect(closeError.data.code).toBe("revision_conflict");
    } finally {
      Object.defineProperty(sub, "compareAndSet", { configurable: true, value: original });
    }
  });

  test("a conversation projection CAS that loses the race fails the dual debit closed", () => {
    openConversation(8);
    LeaseStore.issue(buildIssue(), "t1", T0);
    const sub = Storage.get().conversation;
    if (!sub) throw new Error("conversation sub-adapter missing");
    const original = sub.compareAndSet.bind(sub);
    Object.defineProperty(sub, "compareAndSet", {
      configurable: true,
      value: () => false,
    });
    try {
      const error = captureStoreError(() => LeaseStore.sendDebit("lease-1", T0 + 1));
      expect(error.data.code).toBe("revision_conflict");
    } finally {
      Object.defineProperty(sub, "compareAndSet", { configurable: true, value: original });
    }
  });

  test("a debit against a lease whose conversation row vanished fails closed", () => {
    openConversation(8);
    LeaseStore.issue(buildIssue(), "t1", T0);
    const adapter = Storage.get();
    const conversation = adapter.conversation;
    if (!conversation) throw new Error("conversation sub-adapter missing");
    const original = conversation.get.bind(conversation);
    Object.defineProperty(conversation, "get", {
      configurable: true,
      value: () => undefined,
    });
    try {
      const error = captureStoreError(() => LeaseStore.sendDebit("lease-1", T0 + 1));
      expect(error.data.code).toBe("conversation_closed");
    } finally {
      Object.defineProperty(conversation, "get", { configurable: true, value: original });
    }
  });

  test("the sqlite adapter guards its CAS contract", () => {
    openConversation();
    LeaseStore.issue(buildIssue(), "t1", T0);
    const sub = Storage.get().lease;
    if (!sub) throw new Error("lease sub-adapter missing");
    const record = LeaseStore.get("lease-1");
    if (!record) throw new Error("expected record");
    expect(() =>
      sub.compareAndSet("lease-1", 1, { ...record, id: "lease-other", revision: 2 }),
    ).toThrow("Lease id mismatch");
    expect(() => sub.compareAndSet("lease-1", 1, { ...record, revision: 3 })).toThrow(
      "Lease revision must advance exactly once",
    );
    expect(sub.compareAndSet("lease-1", 99, { ...record, revision: 100 })).toBe(false);
  });

  test("reads on a bare adapter fail closed (adapter_absent)", () => {
    Storage.reset();
    Storage.configure({
      transaction: <T>(fn: () => T): T => fn(),
    } as unknown as Storage.Adapter);
    const error = captureStoreError(() => LeaseStore.get("lease-1"));
    expect(error.data.code).toBe("adapter_absent");
  });

  test("transitions on a missing lease fail closed with not_found", () => {
    const error = captureStoreError(() => LeaseStore.close("lease-x", "owner", "trace", T0));
    expect(error.data.code).toBe("not_found");
    const debitError = captureStoreError(() => LeaseStore.sendDebit("lease-x", T0));
    expect(debitError.data.code).toBe("not_found");
  });

  test("every lease event inherits its caller's trace — no mint in the store", async () => {
    openConversation();
    const traced: Array<{ name: string; traceId: unknown }> = [];
    Bus.observe((event, data) => {
      if (event.name.startsWith("lease.")) {
        traced.push({ name: event.name, traceId: (data as { traceId?: string }).traceId });
      }
    });

    LeaseStore.issue(buildIssue(), "trace-issue", T0);
    LeaseStore.close("lease-1", "owner", "trace-close", T0 + 1);

    await flushBus();
    expect(traced).toEqual([
      { name: "lease.issued", traceId: "trace-issue" },
      { name: "lease.closed", traceId: "trace-close" },
    ]);
  });
});
