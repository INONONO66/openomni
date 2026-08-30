import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Wait } from "@openomni/protocol";
import { Storage, WaitStore } from "../../src/index";
import { Bus } from "@openomni/telemetry";
import { bareStorageAdapter, buildWaitCreate, captureStoreError } from "../helpers/wait";

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

describe("WaitStore", () => {
  test("every wait event inherits its caller's trace — no mint in the store (D11)", async () => {
    const traced: Array<{ name: string; traceId: unknown }> = [];
    Bus.observe((event, data) => {
      if (event.name.startsWith("wait.")) {
        traced.push({ name: event.name, traceId: (data as { traceId?: string }).traceId });
      }
    });

    const record = WaitStore.create(buildWaitCreate(), "trace-open");
    WaitStore.attachReply(
      record.id,
      {
        replyKey: "reply-key-1",
        responderCandidates: ["actor-a"],
        messageId: "in-msg-1",
        at: 1_000,
      },
      "trace-reply",
    );
    const second = WaitStore.create(
      buildWaitCreate({ id: "wait-cancel", originMessageId: "message-cancel" }),
      "trace-open-2",
    );
    WaitStore.cancel(second.id, "trace-cancel");

    await flushBus();
    expect(traced).toEqual([
      { name: "wait.opened", traceId: "trace-open" },
      { name: "wait.reply_attached", traceId: "trace-reply" },
      { name: "wait.opened", traceId: "trace-open-2" },
      { name: "wait.cancelled", traceId: "trace-cancel" },
    ]);
  });

  test("wait events refuse an untraced payload", () => {
    // Enforcement is compile-time for typed producers; the schema states the
    // invariant so any future strict consumer refuses. All EventBase events
    // share the one base; SyncAsk has its own pinned schema (batch 5).
    const base = { id: "wait-1", ownerKind: "session", ownerId: "ses-1", status: "open", time: 1 };
    expect(Wait.Events.Opened.schema.safeParse(base).success).toBe(false);
    expect(Wait.Events.Opened.schema.safeParse({ ...base, traceId: "" }).success).toBe(false);
    expect(Wait.Events.Opened.schema.safeParse({ ...base, traceId: "trace-1" }).success).toBe(true);
  });

  test("owner facts bind sequence, revision, head, and compact payload", () => {
    const created = WaitStore.create(
      buildWaitCreate({ resolutionPolicy: "first_reply", quorum: undefined }),
      "trace-wait-store",
    );
    const resolved = WaitStore.attachReply(
      created.id,
      {
        replyKey: "reply-key-1",
        responderCandidates: ["actor-a"],
        messageId: "in-msg-1",
        at: 1_000,
      },
      "trace-wait-store",
    );
    if (resolved.kind !== "resolved") throw new Error("expected resolved wait");
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    const facts = [...ledger.factsByType("wait.opened"), ...ledger.factsByType("wait.resolved")]
      .filter((fact) => fact.streamId === `wait:${created.id}`)
      .sort((a, b) => a.seq - b.seq);

    expect(facts.map(({ seq, type }) => [seq, type])).toEqual([
      [1, "wait.opened"],
      [2, "wait.resolved"],
    ]);
    expect(resolved.record.revision).toBe(2);
    expect(ledger.headFact(`wait:${created.id}`)?.seq).toBe(resolved.record.revision);
    expect(facts[0]?.data).not.toHaveProperty("replies");
    expect(facts[1]?.data).not.toHaveProperty("replies");
    expect(facts[1]?.data).not.toHaveProperty("correlation");
  });

  test("creates an open wait, persists it, and publishes wait.opened", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    const created = WaitStore.create(buildWaitCreate(), "trace-wait-store");
    const loaded = WaitStore.get("wait-1");

    expect(created.status).toBe("open");
    // Revision 1 at birth: the wait.opened fact is seq 1 on the owner
    // stream `wait:<id>`, and head === revision from create onward (#510).
    expect(created.revision).toBe(1);
    expect(created.partial).toBe(false);
    expect(loaded).toEqual(created);
    await flushBus();
    expect(events).toContain("wait.opened");
  });

  test("rejects a second wait for the same originMessageId with a typed duplicate error", () => {
    WaitStore.create(buildWaitCreate(), "trace-wait-store");

    const error = captureStoreError(() =>
      WaitStore.create(buildWaitCreate({ id: "wait-2" }), "trace-wait-store"),
    );

    expect(error.data.code).toBe("duplicate");
    expect(error.data.waitId).toBe("wait-2");
    expect(WaitStore.get("wait-2")).toBeUndefined();
  });

  test("rejects a duplicate wait id with no owner-stream or Bus side effects", async () => {
    WaitStore.create(buildWaitCreate(), "trace-wait-store");
    await flushBus();
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    const error = captureStoreError(() =>
      WaitStore.create(buildWaitCreate({ originMessageId: "out-msg-2" }), "trace-wait-store"),
    );

    expect(error.data.code).toBe("duplicate");
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    expect(
      ledger.factsByType("wait.opened").filter((fact) => fact.streamId === "wait:wait-1"),
    ).toHaveLength(1);
    expect(ledger.headFact("wait:wait-1")?.seq).toBe(1);
    expect(WaitStore.get("wait-1")?.originMessageId).toBe("out-msg-1");
    await flushBus();
    expect(events).not.toContain("wait.opened");
  });

  test("finds open waits by scoped correlation and rejects other channels", () => {
    WaitStore.create(buildWaitCreate(), "trace-wait-store");

    expect(
      WaitStore.findByCorrelation(
        {
          endpointId: "telegram:seller-1",
          channelId: "telegram:dm",
          replyToMessageId: "reply-1",
        },
        1_000,
      ),
    ).toHaveLength(1);
    expect(
      WaitStore.findByCorrelation(
        {
          endpointId: "telegram:seller-1",
          channelId: "telegram:other",
          replyToMessageId: "reply-1",
        },
        1_000,
      ),
    ).toHaveLength(0);
  });

  test("surfaces open-but-expired rows so the kernel can lazily expire them", () => {
    WaitStore.create(buildWaitCreate(), "trace-wait-store");

    // Deadline judgment is NOT a read-time filter: an open row past its
    // expiresAt still correlates, the fold rejects the reply as
    // deadline_passed, and the kernel folds the wait to expired. Silently
    // dropping it here would leak late replies into surface routing.
    const matches = WaitStore.findByCorrelation({ tokenHash: "tok-1" }, 10_001);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: "wait-1", status: "open" });
  });

  test("keeps resolved waits correlatable only inside the follow-up window", () => {
    WaitStore.create(
      buildWaitCreate({ resolutionPolicy: "first_reply", quorum: undefined }),
      "trace-wait-store",
    );
    const outcome = WaitStore.attachReply(
      "wait-1",
      {
        replyKey: "reply-key-1",
        responderCandidates: ["actor-a"],
        messageId: "in-msg-1",
        at: 1_000,
      },
      "trace-wait-store",
    );
    expect(outcome.kind).toBe("resolved");

    expect(WaitStore.findByCorrelation({ tokenHash: "tok-1" }, 2_000)).toHaveLength(1);
    expect(WaitStore.findByCorrelation({ tokenHash: "tok-1" }, 2_001)).toHaveLength(0);
  });

  test("adopts a pre-cutover row (revision >= 1, empty stream) at ITS revision before the first transition", () => {
    // Simulate an old-DB wait: the projection row exists at revision 3 but
    // its owner stream is empty (every write predates the #510 phase-B
    // cutover). Seeded at the adapter layer, exactly as such rows persist.
    const adapter = Storage.get().wait;
    if (!adapter) throw new Error("wait sub-adapter missing");
    const record = Wait.Record.parse({
      ...buildWaitCreate(),
      status: "open",
      partial: false,
      replies: [],
      revision: 3,
    });
    expect(adapter.create(record)).toBe(true);

    const outcome = WaitStore.attachReply(
      "wait-1",
      {
        replyKey: "reply-key-1",
        responderCandidates: ["actor-a"],
        messageId: "in-msg-1",
        at: 1_000,
      },
      "trace-wait-store",
    );

    expect(outcome.kind).toBe("attached");
    expect(WaitStore.get("wait-1")?.revision).toBe(4);
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    // The wait.adopted genesis landed at seq === the observed revision and
    // the transition fact followed at revision + 1 (head↔revision intact).
    const adopted = ledger.factsByType("wait.adopted");
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ streamId: "wait:wait-1", seq: 3 });
    expect(adopted[0]?.data).toMatchObject({ revision: 3 });
    expect(ledger.headFact("wait:wait-1")).toMatchObject({ seq: 4, type: "wait.attached" });
  });

  test("persists fold outcomes through the revision CAS and publishes reply events", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    WaitStore.create(buildWaitCreate(), "trace-wait-store");

    const attached = WaitStore.attachReply(
      "wait-1",
      {
        replyKey: "reply-key-1",
        responderCandidates: ["actor-a"],
        messageId: "in-msg-1",
        at: 1_000,
      },
      "trace-wait-store",
    );
    const resolved = WaitStore.attachReply(
      "wait-1",
      {
        replyKey: "reply-key-2",
        responderCandidates: ["actor-b"],
        messageId: "in-msg-1",
        at: 2_000,
      },
      "trace-wait-store",
    );
    const persisted = WaitStore.get("wait-1");

    expect(attached.kind).toBe("attached");
    expect(resolved.kind).toBe("resolved");
    expect(persisted?.status).toBe("resolved");
    expect(persisted?.revision).toBe(3);
    expect(persisted?.replies).toHaveLength(2);
    expect(persisted?.resolvedAt).toBe(2_000);
    await flushBus();
    expect(events.filter((name) => name === "wait.reply_attached")).toHaveLength(2);
    expect(events).toContain("wait.resolved");
  });

  test("rejected replies write nothing and publish wait.reply_rejected", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    WaitStore.create(buildWaitCreate(), "trace-wait-store");
    WaitStore.attachReply(
      "wait-1",
      {
        replyKey: "reply-key-1",
        responderCandidates: ["actor-a"],
        messageId: "in-msg-1",
        at: 1_000,
      },
      "trace-wait-store",
    );

    const duplicate = WaitStore.attachReply(
      "wait-1",
      {
        replyKey: "reply-key-1",
        responderCandidates: ["actor-b"],
        messageId: "in-msg-1",
        at: 2_000,
      },
      "trace-wait-store",
    );
    const ambiguous = WaitStore.attachReply(
      "wait-1",
      {
        replyKey: "reply-key-3",
        responderCandidates: ["actor-b", "actor-c"],
        messageId: "in-msg-1",
        at: 2_100,
      },
      "trace-wait-store",
    );
    const persisted = WaitStore.get("wait-1");

    expect(duplicate.kind).toBe("rejected");
    if (duplicate.kind !== "rejected") throw new Error("expected rejected");
    expect(duplicate.code).toBe("duplicate_reply");
    expect(ambiguous.kind).toBe("rejected");
    if (ambiguous.kind !== "rejected") throw new Error("expected rejected");
    expect(ambiguous.code).toBe("ambiguous_responder");
    // Quorum unchanged: still the single attached reply at revision 2.
    expect(persisted?.revision).toBe(2);
    expect(persisted?.replies).toHaveLength(1);
    expect(persisted?.status).toBe("open");
    await flushBus();
    expect(events.filter((name) => name === "wait.reply_rejected")).toHaveLength(2);
  });

  test("expires a partially answered wait and persists partial: true", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    WaitStore.create(buildWaitCreate(), "trace-wait-store");
    WaitStore.attachReply(
      "wait-1",
      {
        replyKey: "reply-key-1",
        responderCandidates: ["actor-a"],
        messageId: "in-msg-1",
        at: 1_000,
      },
      "trace-wait-store",
    );

    const outcome = WaitStore.expire("wait-1", "trace-wait-store", 10_001);
    const persisted = WaitStore.get("wait-1");

    expect(outcome.kind).toBe("expired");
    if (outcome.kind !== "expired") throw new Error("expected expired");
    expect(outcome.partial).toBe(true);
    expect(persisted?.status).toBe("expired");
    expect(persisted?.partial).toBe(true);
    expect(WaitStore.list(["expired"])).toHaveLength(1);
    await flushBus();
    expect(events).toContain("wait.expired");
  });

  test("recordDeliveryReceipt persists the re-keyed correlation projection through the CAS", async () => {
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));
    WaitStore.create(buildWaitCreate(), "trace-wait-store");

    const outcome = WaitStore.recordDeliveryReceipt(
      "wait-1",
      {
        externalMessageId: "platform:msg-1",
        at: 500,
      },
      "trace-wait-store",
    );
    const persisted = WaitStore.get("wait-1");

    expect(outcome.kind).toBe("delivery_recorded");
    expect(persisted?.correlation.replyToMessageId).toBe("platform:msg-1");
    expect(persisted?.revision).toBe(2);
    // The adapter's correlation projection columns moved with the record:
    // lookups answer the platform id and no longer the internal one.
    expect(WaitStore.findByCorrelation({ replyToMessageId: "platform:msg-1" }, 1_000)).toHaveLength(
      1,
    );
    expect(WaitStore.findByCorrelation({ replyToMessageId: "reply-1" }, 1_000)).toHaveLength(0);
    await flushBus();
    // No Bus projection for this transition: the durable
    // wait.delivery_recorded fact lives on the owner stream only.
    expect(events).toEqual(["wait.opened"]);
  });

  test("a delivery receipt on a terminal wait rejects wait_terminal and writes nothing", () => {
    WaitStore.create(buildWaitCreate(), "trace-wait-store");
    WaitStore.cancel("wait-1", "trace-wait-store", 400);

    const outcome = WaitStore.recordDeliveryReceipt(
      "wait-1",
      {
        externalMessageId: "platform:msg-late",
        at: 500,
      },
      "trace-wait-store",
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("expected rejected");
    expect(outcome.code).toBe("wait_terminal");
    expect(WaitStore.get("wait-1")?.correlation.replyToMessageId).toBe("reply-1");
  });

  test("a concurrent write between read and CAS raises a typed revision_conflict", async () => {
    WaitStore.create(buildWaitCreate(), "trace-wait-store");
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    const error = captureStoreError(() =>
      WaitStore.transition(
        "wait-1",
        (record) => {
          // Concurrent writer advances the revision after this step read it.
          WaitStore.cancel("wait-1", "trace-wait-store", 500);
          return Wait.expire(record, { at: 20_000 });
        },
        "trace-wait-store",
      ),
    );

    expect(error.data.code).toBe("revision_conflict");
    expect(error.data.waitId).toBe("wait-1");
    expect(WaitStore.get("wait-1")?.cancelledAt).toBe(500);
    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    expect(ledger.headFact("wait:wait-1")).toMatchObject({ seq: 2, type: "wait.cancelled" });
    expect(
      ledger.factsByType("wait.expired").filter((fact) => fact.streamId === "wait:wait-1"),
    ).toHaveLength(0);
    await flushBus();
    expect(events).toContain("wait.cancelled");
    expect(events).not.toContain("wait.expired");
  });

  test("transition on a missing wait raises a typed not_found error", () => {
    const error = captureStoreError(() =>
      WaitStore.transition(
        "wait-missing",
        (record) => Wait.cancel(record, { at: 1 }),
        "trace-wait-store",
      ),
    );

    expect(error.data.code).toBe("not_found");
  });

  test("fails closed with a typed adapter_absent error when the wait sub-adapter is missing", () => {
    Storage.configure(bareStorageAdapter());

    const createError = captureStoreError(() =>
      WaitStore.create(buildWaitCreate(), "trace-wait-store"),
    );
    const readError = captureStoreError(() => WaitStore.get("wait-1"));

    expect(createError.data.code).toBe("adapter_absent");
    expect(readError.data.code).toBe("adapter_absent");
  });

  test("waits survive adapter reconfiguration on the same database", () => {
    const adapter = Storage.get();
    WaitStore.create(buildWaitCreate(), "trace-wait-store");

    Storage.configure(adapter);

    expect(WaitStore.get("wait-1")?.status).toBe("open");
  });
});
