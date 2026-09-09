import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Inbox, type LedgerSession, L0Observation } from "@openomni/protocol";
import { SessionHandleStore, Storage } from "../../src/index";
import { Bus } from "../helpers/observation";
import { expectCommitted, requestFixture, requestStateAction } from "../helpers/request";
import { materializeSession } from "../helpers/session";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";
import { createMemoryL0Adapter } from "../storage/memory-l0-adapter";

function reply(): Inbox.Commit {
  return {
    id: "reply",
    sessionId: "request-session",
    kind: "prompt",
    content: "answer",
    createdAt: 99,
    parentActionId: "original",
    origin: { encodingVersion: 1, value: { requestId: "original", responderId: "alice" } },
  };
}

function openRequest() {
  const fixture = requestFixture();
  expectCommitted(fixture.commit([fixture.original, requestStateAction(fixture.request)]));
  const transition = (
    state: "resolved" | "expired",
    overrides: Partial<LedgerSession.Commit> = {},
  ) =>
    SessionHandleStore.commitRequestTransition({
      sessionId: fixture.request.sessionId,
      owner: "writer",
      fence: fixture.lease.fence,
      now: state === "expired" ? 100 : 99,
      expectedRevision: SessionHandleStore.row(fixture.request.sessionId).revision,
      actions: [
        requestStateAction(
          {
            ...fixture.request,
            state,
            outcome: state === "expired" ? "outcome_unknown" : "answered",
          },
          "original:resolution",
          state === "resolved" ? "reply" : "request",
        ),
      ],
      consumeInboxIds: [],
      state: "idle",
      releaseLease: false,
      ...overrides,
    });
  return { ...fixture, transition };
}

describe.each(["memory", "sqlite"] as const)("%s canonical request deadline", (backend) => {
  beforeEach(() => {
    if (backend === "memory") Storage.configure(createMemoryL0Adapter());
    else Storage.initialize({ dbPath: ":memory:" });
  });
  afterEach(() => Storage.reset());

  test("only the request transaction projects the deadline and timeout creates no prompt", () => {
    const { transition } = openRequest();
    expect(Storage.get().alarms?.due(99)).toEqual([]);
    expect(Storage.get().alarms?.due(100)).toMatchObject([
      {
        id: "original:deadline",
        sessionId: "request-session",
        spec: { value: { kind: "request_deadline", requestId: "original" } },
        status: "armed",
      },
    ]);
    // Reading due alarms cannot make a lifecycle decision.
    expect(SessionHandleStore.requestById("original")?.state).toBe("open");
    expectCommitted(transition("expired"));
    expect(Storage.get().alarms?.due(100)).toEqual([]);
    expect(SessionHandleStore.requestById("original")?.outcome).toBe("outcome_unknown");
    expect(SessionHandleStore.inboxRows("request-session")).toEqual([]);
    expect(transition("expired")).toMatchObject({ ok: false, reason: "revision" });
  });

  test("answer and receiving inbox commit together, and timeout loses the terminal CAS", () => {
    const { transition } = openRequest();
    const result = expectCommitted(transition("resolved", { receive: reply() }));
    expect(result.receipts.map(({ action }) => action.id)).toEqual([
      "original:resolution",
      "reply",
    ]);
    expect(result.row.revision).toBe(5);
    expect(SessionHandleStore.inboxRows("request-session").map(({ id }) => id)).toEqual(["reply"]);
    expect(SessionHandleStore.requestById("original")?.state).toBe("resolved");
    expect(Storage.get().alarms?.due(100)).toEqual([]);
    expect(transition("expired")).toMatchObject({ ok: false, reason: "revision" });
  });

  test("timeout winner refuses a late answer and its receiving inbox", () => {
    const { transition } = openRequest();
    expectCommitted(transition("expired"));
    const before = SessionHandleStore.tree("request-session");
    expect(transition("resolved", { receive: reply() })).toMatchObject({
      ok: false,
      reason: "revision",
    });
    expect(SessionHandleStore.tree("request-session")).toEqual(before);
    expect(SessionHandleStore.inboxRows("request-session")).toEqual([]);
  });

  test.each([
    { owner: "foreign", reason: "stale" },
    { expectedRevision: 1, reason: "revision" },
    { receive: { ...reply(), sessionId: "other" }, reason: "inbox" },
    { receive: { ...reply(), parentActionId: "missing" }, reason: "inbox" },
    { receive: { ...reply(), id: "original" }, reason: "inbox" },
  ])("refused transition preserves request, alarm and revision: %j", ({ reason, ...overrides }) => {
    const { transition } = openRequest();
    materializeSession("other");
    const before = SessionHandleStore.row("request-session");
    const tree = SessionHandleStore.tree("request-session");
    const alarms = Storage.get().alarms?.due(100);
    expect(transition("resolved", overrides)).toMatchObject({ ok: false, reason });
    expect(SessionHandleStore.row("request-session")).toEqual(before);
    expect(SessionHandleStore.tree("request-session")).toEqual(tree);
    expect(Storage.get().alarms?.due(100)).toEqual(alarms);
    expect(SessionHandleStore.inboxRows("request-session")).toEqual([]);
    expect(SessionHandleStore.inboxRows("other")).toEqual([]);
  });

  test("idempotent receive keeps the original receipt even after consumption", () => {
    const { commit } = openRequest();
    const first = SessionHandleStore.commitReceivedMessage(reply());
    const duplicate = SessionHandleStore.commitReceivedMessage({
      ...reply(),
      createdAt: 100,
      parentActionId: null,
      origin: { encodingVersion: 1, value: { responderId: "alice", requestId: "original" } },
    });
    expect(duplicate).toEqual(first);
    expectCommitted(commit([]));
    expectCommitted(
      SessionHandleStore.commit({
        sessionId: "request-session",
        owner: "writer",
        fence: 1,
        now: 101,
        expectedRevision: first.receipt.revision,
        actions: [],
        consumeInboxIds: ["reply"],
        state: "idle",
        releaseLease: false,
      }),
    );
    const consumed = SessionHandleStore.commitReceivedMessage(reply());
    expect(consumed.row.status).toBe("consumed");
    expect(consumed.receipt).toEqual(first.receipt);
    expect(SessionHandleStore.row("request-session").revision).toBe(first.receipt.revision);
    expect(SessionHandleStore.inboxRows("request-session")).toHaveLength(1);
  });

  test.each([
    { content: "altered" },
    { sessionId: "other" },
    { kind: "interrupt" as const },
    { origin: { encodingVersion: 1 as const, value: { requestId: "different" } } },
  ])("receive rejects changed durable identity fields: %j", (change) => {
    openRequest();
    SessionHandleStore.commitReceivedMessage(reply());
    const before = SessionHandleStore.tree("request-session");
    expect(() => SessionHandleStore.commitReceivedMessage({ ...reply(), ...change })).toThrow(
      "message identity reused with different payload",
    );
    expect(SessionHandleStore.tree("request-session")).toEqual(before);
    expect(SessionHandleStore.inboxRows("request-session")).toHaveLength(1);
  });
});

describe("durable request projection", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = tempDbPath("request-deadline");
    Bus.reset();
    Storage.initialize({ dbPath, observationSink: Bus });
  });
  afterEach(() => {
    Storage.reset();
    Bus.reset();
    removeSqliteFiles(dbPath);
  });

  test("reply signal sees the complete transaction through an independent connection", async () => {
    const { transition } = openRequest();
    const observed = Promise.withResolvers<void>();
    const timeout = setTimeout(() => observed.reject(new Error("missing request signal")), 10_000);
    const unsubscribe = Bus.subscribe(L0Observation.ActionCommittedEvent, (event) => {
      if (event.id !== "original:resolution") return;
      observed.resolve();
    });
    try {
      expectCommitted(transition("resolved", { receive: reply() }));
      await observed.promise;
      using independent = new Database(dbPath, { readonly: true });
      expect(independent.query("SELECT id FROM inbox WHERE id='reply'").get()).toEqual({
        id: "reply",
      });
      expect(
        independent.query("SELECT status FROM alarm WHERE id='original:deadline'").get(),
      ).toEqual({ status: "cancelled" });
      expect(SessionHandleStore.requestById("original")?.state).toBe("resolved");
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
  });

  test.each([
    "alarm",
    "inbox",
  ] as const)("%s fault rolls back terminal CAS and survives restart", (table) => {
    const { transition } = openRequest();
    using raw = new Database(dbPath);
    raw.run(`CREATE TRIGGER refuse_projection BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'projection fault'); END`);
    const before = SessionHandleStore.row("request-session");
    const tree = SessionHandleStore.tree("request-session");
    expect(() => transition("resolved", { receive: reply() })).toThrow("projection fault");
    expect(SessionHandleStore.row("request-session")).toEqual(before);
    expect(SessionHandleStore.tree("request-session")).toEqual(tree);
    expect(SessionHandleStore.inboxRows("request-session")).toEqual([]);
    expect(Storage.get().alarms?.due(100)).toHaveLength(1);
    raw.run("DROP TRIGGER refuse_projection");
    Storage.reset();
    Storage.initialize({ dbPath, observationSink: Bus });
    expectCommitted(transition("expired"));
    Storage.reset();
    Storage.initialize({ dbPath, observationSink: Bus });
    expect(transition("resolved", { receive: reply() })).toMatchObject({
      ok: false,
      reason: "revision",
    });
    expect(SessionHandleStore.requestById("original")?.state).toBe("expired");
    expect(SessionHandleStore.inboxRows("request-session")).toEqual([]);
    expect(raw.query("SELECT status FROM alarm WHERE id='original:deadline'").get()).toEqual({
      status: "fired",
    });
  });

  test("receive retry after restart returns the same durable action receipt", () => {
    openRequest();
    const first = SessionHandleStore.commitReceivedMessage(reply());
    Storage.reset();
    Storage.initialize({ dbPath });
    expect(SessionHandleStore.commitReceivedMessage({ ...reply(), createdAt: 102 })).toEqual(first);
    expect(SessionHandleStore.inboxRows("request-session")).toHaveLength(1);
  });
});
