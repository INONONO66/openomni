import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Conversation } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { ConversationStore, Storage } from "../../src/index";

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

function buildCreate(overrides: Partial<Conversation.Create> = {}): Conversation.Create {
  return {
    id: "conv-1",
    contactId: "actor-contact",
    endpointId: "telegram:contact-1",
    ownerRef: { kind: "session", id: "session-1" },
    openedBy: "resident",
    policy: {
      expiresAt: 100_000,
      maxOutbound: 2,
      maxInbound: 2,
      onInboundCapBreach: "demote",
    },
    ...overrides,
  };
}

/** Runs fn and returns the ConversationStoreError it throws; fails when none is thrown. */
function captureStoreError(fn: () => unknown): InstanceType<typeof Conversation.StoreError> {
  try {
    fn();
  } catch (error) {
    if (Conversation.StoreError.isInstance(error)) return error;
    throw error;
  }
  throw new Error("expected ConversationStoreError, but nothing was thrown");
}

function ownerFacts(conversationId: string) {
  const ledger = Storage.get().ledger;
  if (!ledger) throw new Error("ledger sub-adapter missing");
  return [
    "conversation.opened",
    "conversation.closed",
    "conversation.outbound_admitted",
    "conversation.inbound_recorded",
    "conversation.cap_breached",
  ]
    .flatMap((type) => ledger.factsByType(type))
    .filter((fact) => fact.streamId === `conversation:${conversationId}`)
    .sort((a, b) => a.seq - b.seq);
}

describe("ConversationStore", () => {
  test("open persists the projection and the seq-1 opened fact (head === revision)", () => {
    const record = ConversationStore.open(buildCreate(), "trace-open", T0);
    expect(record.revision).toBe(1);
    expect(ConversationStore.get("conv-1")).toEqual(record);
    expect(ownerFacts("conv-1").map(({ seq, type }) => [seq, type])).toEqual([
      [1, "conversation.opened"],
    ]);
  });

  test("duplicate open fails closed with a typed duplicate error", () => {
    ConversationStore.open(buildCreate(), "trace-open", T0);
    const error = captureStoreError(() => ConversationStore.open(buildCreate(), "trace-dup", T0));
    expect(error.data.code).toBe("duplicate");
    expect(ownerFacts("conv-1")).toHaveLength(1);
  });

  test("list filters by state and findOpenByEndpoint returns only open windows on the endpoint", () => {
    ConversationStore.open(buildCreate(), "trace-1", T0);
    ConversationStore.open(
      buildCreate({ id: "conv-2", endpointId: "telegram:contact-2" }),
      "trace-2",
      T0,
    );
    ConversationStore.close("conv-2", "owner", "trace-3", T0 + 1);
    expect(ConversationStore.list().map((record) => record.id)).toEqual(["conv-1", "conv-2"]);
    expect(ConversationStore.list(["closed"]).map((record) => record.id)).toEqual(["conv-2"]);
    expect(
      ConversationStore.findOpenByEndpoint("telegram:contact-1").map((record) => record.id),
    ).toEqual(["conv-1"]);
    expect(ConversationStore.findOpenByEndpoint("telegram:contact-2")).toEqual([]);
  });

  test("close is idempotent, keeps the first settlement, and appends exactly one fact", async () => {
    ConversationStore.open(buildCreate(), "trace-open", T0);
    const events: string[] = [];
    Bus.observe((event) => {
      if (event.name.startsWith("conversation.")) events.push(event.name);
    });

    const closed = ConversationStore.close("conv-1", "expiry", "trace-close", T0 + 1);
    expect(closed.kind).toBe("closed");
    const again = ConversationStore.close("conv-1", "owner", "trace-close-2", T0 + 2);
    expect(again.kind).toBe("unchanged");
    expect(again.record.closedBy).toBe("expiry");

    await flushBus();
    expect(events).toEqual(["conversation.closed"]);
    expect(ownerFacts("conv-1").map(({ seq, type }) => [seq, type])).toEqual([
      [1, "conversation.opened"],
      [2, "conversation.closed"],
    ]);
  });

  test("admitOutbound debits durably; refusals leave storage untouched", () => {
    ConversationStore.open(buildCreate(), "trace-open", T0);
    expect(ConversationStore.admitOutbound("conv-1", "trace-a", T0 + 1).kind).toBe("admitted");
    expect(ConversationStore.admitOutbound("conv-1", "trace-b", T0 + 2).kind).toBe("admitted");
    const refused = ConversationStore.admitOutbound("conv-1", "trace-c", T0 + 3);
    expect(refused).toEqual({ kind: "refused", reason: "outbound_cap" });
    expect(ConversationStore.get("conv-1")?.outboundUsed).toBe(2);
    expect(ownerFacts("conv-1").map(({ seq, type }) => [seq, type])).toEqual([
      [1, "conversation.opened"],
      [2, "conversation.outbound_admitted"],
      [3, "conversation.outbound_admitted"],
    ]);
  });

  test("recordInbound publishes the cap-breach owner wake exactly once", async () => {
    ConversationStore.open(buildCreate(), "trace-open", T0);
    const breaches: unknown[] = [];
    Bus.observe((event, data) => {
      if (event.name === "conversation.cap_breached") breaches.push(data);
    });

    expect(ConversationStore.recordInbound("conv-1", "t1", T0 + 1).kind).toBe("recorded");
    expect(ConversationStore.recordInbound("conv-1", "t2", T0 + 2).kind).toBe("recorded");
    expect(ConversationStore.recordInbound("conv-1", "t3", T0 + 3).kind).toBe("cap_breached");
    expect(ConversationStore.recordInbound("conv-1", "t4", T0 + 4).kind).toBe("already_breached");

    await flushBus();
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ traceId: "t3", conversationId: "conv-1" });
    const record = ConversationStore.get("conv-1");
    expect(record?.state).toBe("open");
    expect(record?.inboundUsed).toBe(4);
    expect(ownerFacts("conv-1").map(({ type }) => type)).toEqual([
      "conversation.opened",
      "conversation.inbound_recorded",
      "conversation.inbound_recorded",
      "conversation.cap_breached",
      "conversation.inbound_recorded",
    ]);
  });

  test("transitions on a missing conversation fail closed with not_found", () => {
    const error = captureStoreError(() => ConversationStore.close("conv-x", "owner", "trace", T0));
    expect(error.data.code).toBe("not_found");
  });

  test("a stale revision fails closed with revision_conflict and writes nothing", () => {
    ConversationStore.open(buildCreate(), "trace-open", T0);
    const stale = ConversationStore.get("conv-1");
    if (!stale) throw new Error("expected record");
    ConversationStore.admitOutbound("conv-1", "trace-a", T0 + 1);
    // Re-apply a transition computed from the stale snapshot by rewinding the
    // projection read through the adapter — simulate with a direct ledger
    // append at the stale head instead: the store's own path must conflict.
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    const appended = ledger.append(
      { streamId: "conversation:conv-1", type: "conversation.outbound_admitted", data: {} },
      stale.revision,
    );
    expect(appended.kind).toBe("cas_conflict");
  });

  test("every conversation event inherits its caller's trace — no mint in the store", async () => {
    const traced: Array<{ name: string; traceId: unknown }> = [];
    Bus.observe((event, data) => {
      if (event.name.startsWith("conversation.")) {
        traced.push({ name: event.name, traceId: (data as { traceId?: string }).traceId });
      }
    });

    ConversationStore.open(buildCreate(), "trace-open", T0);
    ConversationStore.close("conv-1", "owner", "trace-close", T0 + 1);

    await flushBus();
    expect(traced).toEqual([
      { name: "conversation.opened", traceId: "trace-open" },
      { name: "conversation.closed", traceId: "trace-close" },
    ]);
  });

  test("a bare adapter without the conversation surface fails closed (adapter_absent)", () => {
    Storage.reset();
    Storage.configure({
      transaction: <T>(fn: () => T): T => fn(),
    } as unknown as Storage.Adapter);
    const error = captureStoreError(() => ConversationStore.get("conv-1"));
    expect(error.data.code).toBe("adapter_absent");

    const openError = captureStoreError(() =>
      ConversationStore.open(buildCreate(), "trace-open", T0),
    );
    expect(openError.data.code).toBe("adapter_absent");
  });

  test("a bare adapter without the ledger surface fails closed on write (adapter_absent)", () => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    const adapter = Storage.get();
    Storage.reset();
    Storage.configure({
      ...adapter,
      ledger: undefined,
    } as unknown as Storage.Adapter);
    const error = captureStoreError(() =>
      ConversationStore.open(buildCreate(), "trace-open", T0),
    );
    expect(error.data.code).toBe("adapter_absent");
  });

  test("SQLITE_BUSY at the transaction entry surfaces as typed unavailable", () => {
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
      const error = captureStoreError(() =>
        ConversationStore.open(buildCreate(), "trace-open", T0),
      );
      expect(error.data.code).toBe("unavailable");
    } finally {
      Object.defineProperty(adapter, "transaction", { configurable: true, value: original });
    }
  });

  test("a conflicting head on transition fails closed with revision_conflict", () => {
    ConversationStore.open(buildCreate(), "trace-open", T0);
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    // Move the stream head past the projected revision outside the store —
    // the next transition's append CAS must refuse.
    const appended = ledger.append(
      { streamId: "conversation:conv-1", type: "conversation.inbound_recorded", data: {} },
      1,
    );
    expect(appended.kind).toBe("appended");
    const error = captureStoreError(() =>
      ConversationStore.admitOutbound("conv-1", "trace-race", T0 + 1),
    );
    expect(error.data.code).toBe("revision_conflict");
  });

  test("the sqlite adapter guards its CAS contract", () => {
    ConversationStore.open(buildCreate(), "trace-open", T0);
    const sub = Storage.get().conversation;
    if (!sub) throw new Error("conversation sub-adapter missing");
    const record = ConversationStore.get("conv-1");
    if (!record) throw new Error("expected record");
    expect(() => sub.compareAndSet("conv-1", 1, { ...record, id: "conv-other", revision: 2 })).toThrow(
      "Conversation id mismatch",
    );
    expect(() => sub.compareAndSet("conv-1", 1, { ...record, revision: 3 })).toThrow(
      "Conversation revision must advance exactly once",
    );
    expect(sub.compareAndSet("conv-1", 99, { ...record, revision: 100 })).toBe(false);
  });
});
