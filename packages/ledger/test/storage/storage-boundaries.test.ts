import { afterEach, expect, test } from "bun:test";
import { Gateway, LedgerSession, PlainValueSchema } from "@openomni/protocol";
import {
  ActorRegistry,
  LedgerAppend,
  SessionHandleStore,
  Storage,
  type SqliteStorageAdapter,
} from "../../src";
import type { LedgerAction } from "@openomni/protocol";
import { createSqliteL0Adapters } from "../../src/storage/sqlite-l0-adapter";
import { openLedgerDatabase } from "../helpers/ledger";
import { materializeSession } from "../helpers/session";
import { createDispositionFixture, seedRetiredWait } from "../helpers/disposition-967";
import { inspect967Projections } from "../../src/storage/u967-projection";

afterEach(() => Storage.reset());

test("append port transaction rolls back an adopted stream and commits a subsequent adoption", () => {
  Storage.initialize({ dbPath: ":memory:" });
  const ledger = Storage.get().ledger;
  if (ledger === undefined) throw new Error("ledger missing");
  expect(() =>
    LedgerAppend.transaction(() => {
      ledger.adoptStream("adopted", 3, { type: "genesis", data: {}, timeCreated: 1 });
      throw new Error("rollback adoption");
    }),
  ).toThrow("rollback adoption");
  expect(ledger.headFact("adopted")).toBeUndefined();
  LedgerAppend.transaction(() =>
    ledger.adoptStream("adopted", 3, { type: "genesis", data: {}, timeCreated: 1 }),
  );
  expect(ledger.headFact("adopted")?.seq).toBe(3);
});

test("removing an endpoint preserves its identity and removes address lookup", () => {
  Storage.initialize({ dbPath: ":memory:" });
  ActorRegistry.registerIdentity({ id: "actor", kind: "human", trustTier: "observer" });
  ActorRegistry.registerEndpoint({
    id: "endpoint",
    actorId: "actor",
    channel: "discord",
    externalId: "external",
  });
  const registry = Storage.get().actorRegistry;
  if (registry === undefined) throw new Error("registry missing");
  expect(registry.removeEndpoint("endpoint")).toBe(true);
  expect(ActorRegistry.getIdentity("actor")?.id).toBe("actor");
  expect(ActorRegistry.resolveEndpoint("discord", "external")).toBeUndefined();
  expect(registry.removeEndpoint("endpoint")).toBe(false);
});

test("lease acquisition reports a refused SQL compare-and-set without advancing its fence", () => {
  using db = openLedgerDatabase();
  const stores = createSqliteL0Adapters(db, (operation) => db.transaction(operation).immediate(), {
    publish: () => undefined,
  });
  stores.sessions.create(
    LedgerSession.Row.parse({
      id: "fenced",
      parentId: null,
      role: "resident",
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
      revision: 0,
      state: "idle",
    }),
  );
  db.run(
    "CREATE TRIGGER refuse_fence BEFORE UPDATE OF lease_fence ON session BEGIN SELECT RAISE(IGNORE); END",
  );
  expect(
    stores.sessions.acquireLease({
      sessionId: "fenced",
      owner: "worker",
      expectedFence: 0,
      now: 1,
      expiresAt: 10,
    }),
  ).toEqual({ ok: false, reason: "stale", currentFence: 0 });
  expect(stores.sessions.get("fenced")?.leaseOwner).toBeNull();
});

test("materialization refuses a mismatched initial action before creating any row", () => {
  Storage.initialize({ dbPath: ":memory:" });
  const existing = materializeSession("source");
  const initial = SessionHandleStore.configureAction({
    id: "configuration",
    sessionId: "source",
    parentId: null,
    operation: "create",
    at: 1,
    snapshot: SessionHandleStore.latestGeneration(SessionHandleStore.tree("source")),
  });
  expect(
    Storage.get().sessions?.materialize({
      row: { ...existing, id: "new", revision: 0 },
      initialAction: initial,
    }),
  ).toBeUndefined();
  expect(SessionHandleStore.listRows().map((row) => row.id)).toEqual(["source"]);
});

test("session commit savepoints roll back every refused write unit", () => {
  Storage.initialize({ dbPath: ":memory:" });
  const session = materializeSession("savepoint");
  SessionHandleStore.acquireLease({
    sessionId: session.id,
    owner: "owner",
    expectedFence: 0,
    now: 1,
    expiresAt: 100,
  });
  const base = {
    sessionId: session.id,
    owner: "owner",
    fence: 1,
    now: 2,
    expectedRevision: 1,
    actions: [],
    consumeInboxIds: [],
    state: "idle" as const,
    releaseLease: true,
  };
  expect(SessionHandleStore.commit({ ...base, consumeInboxIds: ["missing"] })).toEqual({
    ok: false,
    reason: "inbox",
    currentFence: 1,
    currentRevision: 1,
  });
  const db = (Storage.get() as SqliteStorageAdapter).testDatabase();
  db.run(
    "CREATE TRIGGER refuse_revision BEFORE UPDATE OF revision ON session BEGIN SELECT RAISE(IGNORE); END",
  );
  const action: LedgerAction.Append = {
    id: "refused-action",
    parentId: null,
    sessionId: session.id,
    kind: "tool",
    intent: { encodingVersion: 1, value: {} },
    effect: { encodingVersion: 1, value: {} },
    irreversible: true,
    ts: 2,
  };
  expect(SessionHandleStore.commit({ ...base, actions: [action] })).toMatchObject({
    reason: "revision",
  });
  db.run("DROP TRIGGER refuse_revision");
  expect(
    SessionHandleStore.commitInbox({
      id: "pending",
      sessionId: session.id,
      parentActionId: null,
      kind: "prompt",
      content: "pending",
      origin: { encodingVersion: 1, value: {} },
      createdAt: 3,
    }),
  ).toBeDefined();
  db.run(
    "CREATE TRIGGER refuse_consume BEFORE UPDATE OF status ON inbox BEGIN SELECT RAISE(IGNORE); END",
  );
  expect(
    SessionHandleStore.commit({
      ...base,
      expectedRevision: 2,
      consumeInboxIds: ["pending"],
      now: 4,
    }),
  ).toMatchObject({ reason: "inbox" });
  db.run("DROP TRIGGER refuse_consume");
  const duplicate = {
    id: `${session.id}:configure`,
    sessionId: session.id,
    parentActionId: null,
    kind: "prompt" as const,
    content: "duplicate",
    origin: { encodingVersion: 1 as const, value: {} },
    createdAt: 5,
  };
  expect(
    SessionHandleStore.commit({ ...base, expectedRevision: 2, receive: duplicate }),
  ).toMatchObject({ reason: "inbox" });
  expect(
    SessionHandleStore.commit({ ...base, expectedRevision: 2, admit: duplicate }),
  ).toMatchObject({ reason: "inbox" });
  const snapshot = SessionHandleStore.latestGeneration(SessionHandleStore.tree(session.id));
  const admission = {
    ...duplicate,
    sessionId: "admitted-child",
    sender: { sessionId: session.id, owner: "owner", fence: 1 },
    limits: { fanout: 4, depth: 4 },
    createSession: {
      row: {
        ...session,
        id: "admitted-child",
        parentId: session.id,
        role: "worker" as const,
        revision: 0,
      },
      initialAction: SessionHandleStore.configureAction({
        id: "admitted-child:configure",
        sessionId: "admitted-child",
        parentId: null,
        operation: "create",
        snapshot,
        at: 5,
      }),
    },
  };
  expect(
    SessionHandleStore.commit({ ...base, expectedRevision: 2, admit: admission }),
  ).toMatchObject({ reason: "inbox" });
  expect(
    SessionHandleStore.commit({
      ...base,
      expectedRevision: 2,
      admit: { ...admission, id: "admitted-message" },
    }),
  ).toMatchObject({ ok: true });
  expect(SessionHandleStore.row("admitted-child").revision).toBe(2);
  expect(SessionHandleStore.row(session.id).revision).toBe(2);
});

test("corrupt session ancestry fails closed before child admission", () => {
  using db = openLedgerDatabase();
  const stores = createSqliteL0Adapters(db, (operation) => db.transaction(operation).immediate(), {
    publish: () => undefined,
  });
  db.run("PRAGMA foreign_keys = OFF");
  stores.sessions.create(
    LedgerSession.Row.parse({
      id: "orphan",
      parentId: "missing",
      role: "resident",
      leaseOwner: "worker",
      leaseFence: 1,
      leaseExpiresAt: 100,
      revision: 0,
      state: "idle",
    }),
  );
  db.run("PRAGMA foreign_keys = ON");
  const snapshot = SessionHandleStore.generationSnapshot({
    generation: 1,
    revertTo: 0,
    tools: [],
    system: { preset: "", blocks: [] },
    policyGeneration: 1,
  });
  expect(() =>
    stores.inbox.commit({
      id: "child-message",
      sessionId: "child",
      parentActionId: null,
      kind: "prompt",
      content: "work",
      origin: { encodingVersion: 1, value: {} },
      createdAt: 2,
      sender: { sessionId: "orphan", owner: "worker", fence: 1 },
      limits: { fanout: 4, depth: 4 },
      createSession: {
        row: {
          id: "child",
          parentId: "orphan",
          role: "worker",
          leaseOwner: null,
          leaseFence: 0,
          leaseExpiresAt: null,
          revision: 0,
          state: "idle",
          toolsGeneration: 1,
          systemHash: snapshot.systemHash,
          policyGeneration: 1,
        },
        initialAction: SessionHandleStore.configureAction({
          id: "child:configure",
          sessionId: "child",
          parentId: null,
          operation: "create",
          snapshot,
          at: 2,
        }),
      },
    }),
  ).toThrow("session ancestry is missing");
  expect(stores.sessions.get("child")).toBeUndefined();
});

test("external reply observations carry the persisted original message identity", () => {
  const messages: Gateway.MessageObservation[] = [];
  Storage.initialize({
    dbPath: ":memory:",
    observationSink: {
      publish(event, payload) {
        if (event.name === Gateway.MessageObserved.name)
          messages.push(Gateway.MessageObserved.schema.parse(payload));
      },
    },
  });
  materializeSession("reply-session");
  const actions = Storage.get().actions;
  if (actions === undefined) throw new Error("actions missing");
  expect(
    actions.append(
      {
        id: "source",
        sessionId: "reply-session",
        parentId: null,
        kind: "tool",
        irreversible: true,
        intent: { encodingVersion: 1, value: { value: { messageId: "original" } } },
        effect: { encodingVersion: 1, value: {} },
        ts: 3,
      },
      1,
    ),
  ).toBeDefined();
  SessionHandleStore.commitInbox({
    id: "reply",
    sessionId: "reply-session",
    parentActionId: null,
    kind: "prompt",
    content: "answer",
    origin: {
      encodingVersion: 1,
      value: {
        kind: "external_reply",
        messageId: "incoming",
        sourceActionId: "source",
        replyTo: "outgoing",
      },
    },
    createdAt: 8,
  });
  expect(messages).toEqual([
    { kind: "message.replied", messageId: "original", replyTo: "outgoing", roundTripMs: 5 },
  ]);
});

test("watch deadline commits timeout even for a repeated batch with exhausted notification budget", () => {
  Storage.initialize({ dbPath: ":memory:" });
  materializeSession("watcher");
  const alarms = Storage.get().alarms;
  if (alarms === undefined) throw new Error("alarms missing");
  alarms.arm({
    id: "watch",
    sessionId: "watcher",
    kind: "watch",
    fireAt: 100,
    spec: {
      encodingVersion: 1,
      value: {
        watch: { command: "true", description: "deadline", timeout_ms: 10 },
        notificationLimit: 1,
        policyGeneration: 1,
      },
    },
  });
  const input = {
    id: "watch",
    epoch: 1,
    fence: 0,
    sourceKey: "first",
    at: 109,
    content: "changed",
    terminal: false,
    batchHash: "same",
  };
  expect(alarms.fire(input)?.row.status).toBe("armed");
  const expired = alarms.fire({ ...input, sourceKey: "timeout", at: 110 });
  expect(expired?.row.status).toBe("fired");
  expect(PlainValueSchema.parse(JSON.parse(expired?.inbox.content ?? "null"))).toEqual({
    alarmId: "watch",
    epoch: 1,
    reason: "timeout",
    exitCode: null,
  });
});

test.each([
  "'$.resolutionPolicy', 'quorum', '$.quorum', json('{\"expected\":2,\"threshold\":1}')",
  "'$.quorum', json('{\"expected\":1,\"threshold\":1}')",
])("archive eligibility rejects inconsistent responder policy: %s", (mutation) => {
  using fixture = createDispositionFixture(false);
  seedRetiredWait(fixture.db);
  fixture.db.run(`UPDATE wait SET data = json_set(data, ${mutation}) WHERE id = 'retired'`);
  expect(inspect967Projections(fixture.db, 200).blocked).toContain("invalid_rows");
});

test.each([
  "UPDATE wait SET data = '{'",
  "UPDATE wait SET data = json_set(data, '$.id', 'mismatch')",
  'UPDATE wait SET data = substr(data, 1, length(data) - 1) || \',"id":"preserved"}\'',
])("archive inspection rejects corrupt JSON or scalar projections: %s", (sql) => {
  using fixture = createDispositionFixture(false);
  fixture.db.run(sql);
  const before = fixture.db.query("SELECT * FROM wait").all();
  expect(inspect967Projections(fixture.db, 200).blocked).toEqual(["invalid_rows"]);
  expect(fixture.db.query("SELECT * FROM wait").all()).toEqual(before);
});

test("archive inspection retains historical delegations and malformed wait rows", () => {
  using fixture = createDispositionFixture(false);
  fixture.db.run(
    "INSERT INTO delegation (delegation_id, status, root_delegation_id, data, time_created) VALUES ('protected', 'settled', 'root', '{}', 1)",
  );
  expect(inspect967Projections(fixture.db, 200).blocked).toEqual(["protected_rows"]);
  fixture.db.run("DELETE FROM delegation");
  fixture.db.run("UPDATE wait SET data = json_set(data, '$.allowedActions', json('[]'))");
  expect(inspect967Projections(fixture.db, 200).blocked).toEqual(["invalid_rows"]);
});
