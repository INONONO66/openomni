import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Alarm,
  Inbox,
  LedgerAction,
  LedgerSession,
  PolicyRow,
  type Storage as ProtocolStorage,
} from "@openomni/protocol";
import { createMemoryL0Adapter } from "./memory-l0-adapter.js";
import { Migration } from "../../src/storage/migration-runner.js";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage.js";
import { Storage } from "../../src/storage/storage.js";

const directories: string[] = [];
let adapter: SqliteStorageAdapter;
let inspection: Database;

interface L0Adapter {
  transaction<T>(operation: () => T): T;
  sessions: ProtocolStorage.SessionLedgerSubAdapter;
  actions: ProtocolStorage.ActionSubAdapter;
  inbox: ProtocolStorage.InboxSubAdapter;
  alarms: ProtocolStorage.AlarmSubAdapter;
  policies: ProtocolStorage.PolicyRowSubAdapter;
}

const encoded = (value: string) => ({ encodingVersion: 1 as const, value: { value } });

function sessionRow(id: string): LedgerSession.Row {
  return LedgerSession.Row.parse({
    id,
    parentId: null,
    role: "resident",
    leaseOwner: null,
    leaseFence: 0,
    leaseExpiresAt: null,
    revision: 0,
    state: "idle",
  });
}

function exerciseL0Contracts(storage: L0Adapter) {
  const session = sessionRow("session-l0");
  expect(storage.sessions.create(session)).toBe(true);
  expect(storage.sessions.create(session)).toBe(false);

  const root = storage.actions.append(
    LedgerAction.Append.parse({
      id: "action-root",
      parentId: null,
      sessionId: session.id,
      kind: "turn",
      intent: encoded("intent"),
      effect: encoded("result"),
      irreversible: true,
      ts: 100,
    }),
    0,
  );
  expect(root?.revision).toBe(1);

  expect(storage.sessions.create(sessionRow("session-other"))).toBe(true);
  expect(
    storage.actions.append(
      LedgerAction.Append.parse({
        id: "action-foreign-parent",
        parentId: "action-root",
        sessionId: "session-other",
        kind: "tool",
        intent: encoded("foreign"),
        effect: encoded("foreign"),
        irreversible: true,
        ts: 100,
      }),
      0,
    ),
  ).toBeUndefined();
  expect(storage.sessions.get("session-other")?.revision).toBe(0);

  const stale = storage.actions.append(
    LedgerAction.Append.parse({
      id: "action-stale",
      parentId: "action-root",
      sessionId: session.id,
      kind: "tool",
      intent: encoded("stale"),
      effect: encoded("stale"),
      irreversible: true,
      ts: 101,
    }),
    0,
  );
  expect(stale).toBeUndefined();

  const reverted = storage.actions.append(
    LedgerAction.Append.parse({
      id: "action-revert",
      parentId: "action-root",
      sessionId: session.id,
      kind: "tool",
      intent: encoded("undo"),
      effect: encoded("undone"),
      revert: encoded("action-root"),
      ts: 102,
    }),
    1,
  );
  expect(reverted?.revision).toBe(2);

  expect(
    storage.inbox.commit(
      Inbox.Commit.parse({
        id: "inbox-2",
        sessionId: session.id,
        kind: "interrupt",
        content: "stop",
        origin: encoded("owner"),
        createdAt: 201,
      }),
    ),
  ).toMatchObject({ ordinal: 1, status: "pending" });
  expect(
    storage.inbox.commit(
      Inbox.Commit.parse({
        id: "inbox-1",
        sessionId: session.id,
        kind: "prompt",
        content: "go",
        origin: encoded("owner"),
        createdAt: 200,
      }),
    ),
  ).toMatchObject({ ordinal: 2, status: "pending" });
  expect(storage.inbox.list(session.id, "pending").map((row) => row.id)).toEqual([
    "inbox-2",
    "inbox-1",
  ]);

  expect(
    storage.alarms.arm(
      Alarm.Arm.parse({
        id: "alarm-later",
        sessionId: session.id,
        kind: "watch",
        fireAt: 500,
      }),
    ),
  ).toMatchObject({ status: "armed" });
  expect(
    storage.alarms.arm(
      Alarm.Arm.parse({
        id: "alarm-now",
        sessionId: session.id,
        kind: "watch",
        fireAt: 400,
        spec: encoded("watch"),
      }),
    ),
  ).toMatchObject({ status: "armed" });
  expect(storage.alarms.cancel("alarm-later", session.id, 450)).toMatchObject({
    status: "cancelled",
  });
  expect(storage.alarms.due(450).map((row) => row.id)).toEqual(["alarm-now"]);
  expect(storage.sessions.get(session.id)?.revision).toBe(7);

  const policy = PolicyRow.Row.parse({
    name: "allow-tool",
    kind: "tool",
    phase: "pre",
    match: encoded("all"),
    verdict: encoded("allow"),
    priority: 10,
    generation: 1,
  });
  expect(storage.policies.append(policy)).toBe(true);
  expect(storage.policies.append(policy)).toBe(false);
  expect(storage.policies.rows()).toEqual([policy]);
  expect(storage.sessions.get(session.id)?.revision).toBe(7);
  const whole = storage.actions.tree(session.id);
  expect(storage.actions.range(session.id, 0, 3)).toEqual(whole.slice(0, 3));
  expect(storage.actions.range(session.id, 3, 100)).toEqual(whole.slice(3));
  expect(storage.actions.range(session.id, whole.length, 1)).toEqual([]);

  return {
    session: storage.sessions.get(session.id),
    tree: storage.actions.tree(session.id),
    inbox: storage.inbox.list(session.id),
    alarms: storage.alarms.due(1000),
    policies: storage.policies.rows(),
  };
}

function database(): Database {
  return inspection;
}

beforeEach(() => {
  Storage.reset();
  const directory = mkdtempSync(join(tmpdir(), "ledger-contract-"));
  directories.push(directory);
  const path = join(directory, "ledger.db");
  adapter = new SqliteStorageAdapter(path);
  inspection = new Database(path);
  Storage.configure(adapter);
});

afterEach(() => {
  inspection.close();
  Storage.reset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("L0 adapter contracts", () => {
  function sqliteAdapter(): L0Adapter {
    return {
      transaction: (operation) => adapter.transaction(operation),
      sessions: adapter.sessions,
      actions: adapter.actions,
      inbox: adapter.inbox,
      alarms: adapter.alarms,
      policies: adapter.policies,
    };
  }

  test("memory and SQLite produce identical action/session/inbox/alarm/policy state", () => {
    expect(exerciseL0Contracts(createMemoryL0Adapter())).toEqual(
      exerciseL0Contracts(sqliteAdapter()),
    );
  });

  test.each([
    ["memory", () => createMemoryL0Adapter()],
    ["SQLite", sqliteAdapter],
  ])("%s refuses orphan alarms and inbox/action id collisions without mutation", (_name, create) => {
    const storage = create();
    const row = sessionRow("session-boundary");
    expect(storage.sessions.create(row)).toBe(true);
    expect(
      storage.alarms.arm(
        Alarm.Arm.parse({ id: "orphan", sessionId: "missing", kind: "at", fireAt: 10 }),
      ),
    ).toBeUndefined();
    expect(
      storage.actions.append(
        LedgerAction.Append.parse({
          id: "collision",
          parentId: null,
          sessionId: row.id,
          kind: "turn",
          intent: encoded("intent"),
          effect: encoded("effect"),
          irreversible: true,
          ts: 10,
        }),
        0,
      ),
    ).toBeDefined();
    expect(
      storage.inbox.commit(
        Inbox.Commit.parse({
          id: "collision",
          sessionId: row.id,
          kind: "prompt",
          content: "content",
          origin: encoded("origin"),
          createdAt: 11,
        }),
      ),
    ).toBeUndefined();
    expect(storage.sessions.get(row.id)?.revision).toBe(1);
    expect(storage.actions.tree(row.id).map((action) => action.kind)).toEqual(["turn"]);
    expect(storage.inbox.list(row.id)).toEqual([]);
  });
});

describe("SQLite adapter contract guards", () => {
  test("fresh schemas omit retired lifecycle tables", () => {
    const rows = database()
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation', 'lease', 'engagement') ORDER BY name",
      )
      .all();

    expect(rows).toEqual([]);
  });

  test("action revision rolls back when the append insert fails", () => {
    const row = sessionRow("session-action-rollback");
    expect(adapter.sessions.create(row)).toBe(true);
    database().exec(`
      CREATE TRIGGER refuse_action BEFORE INSERT ON action
      BEGIN SELECT RAISE(ABORT, 'refuse action'); END
    `);

    expect(() =>
      adapter.actions.append(
        LedgerAction.Append.parse({
          id: "action-rollback",
          parentId: null,
          sessionId: row.id,
          kind: "turn",
          intent: encoded("intent"),
          effect: encoded("effect"),
          irreversible: true,
          ts: 11,
        }),
        0,
      ),
    ).toThrow("refuse action");
    expect(adapter.sessions.get(row.id)?.revision).toBe(0);
    expect(adapter.actions.tree(row.id)).toEqual([]);
  });

  test("inbox action and row roll back together when the row insert fails", () => {
    const row = sessionRow("session-rollback");
    expect(adapter.sessions.create(row)).toBe(true);
    database().exec(`
      CREATE TRIGGER refuse_inbox BEFORE INSERT ON inbox
      BEGIN SELECT RAISE(ABORT, 'refuse inbox'); END
    `);

    expect(() =>
      adapter.inbox.commit(
        Inbox.Commit.parse({
          id: "inbox-rollback",
          sessionId: row.id,
          kind: "prompt",
          content: "content",
          origin: encoded("origin"),
          createdAt: 12,
        }),
      ),
    ).toThrow("refuse inbox");
    expect(adapter.sessions.get(row.id)?.revision).toBe(0);
    expect(adapter.actions.tree(row.id)).toEqual([]);
  });

  test("request action compare-and-set rejects foreign parent and stale revision", () => {
    adapter.sessions.create(sessionRow("request-owner"));
    const action = LedgerAction.Append.parse({
      id: "request",
      parentId: "missing",
      sessionId: "request-owner",
      kind: "request",
      intent: encoded("original"),
      effect: encoded("open"),
      irreversible: true,
      ts: 1,
    });
    expect(adapter.actions.append(action, 0)).toBeUndefined();
    expect(adapter.actions.append({ ...action, parentId: null }, 1)).toBeUndefined();
    expect(adapter.sessions.get("request-owner")?.revision).toBe(0);
    expect(adapter.actions.tree("request-owner")).toEqual([]);
  });

  test("canonical session reads cannot mutate a later snapshot", () => {
    adapter.sessions.create(sessionRow("session-isolated"));
    const first = adapter.sessions.get("session-isolated");
    if (first === undefined) throw new Error("missing session");
    first.revision = 99;
    expect(adapter.sessions.get(first.id)?.revision).toBe(0);
  });
});

describe("migration rollback preservation", () => {
  test("surfaces both the migration failure and failed rollback", () => {
    const directory = mkdtempSync(join(tmpdir(), "ledger-migration-rollback-"));
    directories.push(directory);
    // ON CONFLICT ROLLBACK ends SQLite's transaction before the runner's cleanup.
    writeFileSync(
      join(directory, "broken.sql"),
      `
      CREATE TABLE broken (id TEXT UNIQUE ON CONFLICT ROLLBACK);
      INSERT INTO broken VALUES ('duplicate');
      INSERT INTO broken VALUES ('duplicate');
    `,
    );
    using db = new Database(":memory:");
    const rollbackMessage: object = expect.stringContaining("no transaction is active");
    const migrationMessage: object = expect.stringContaining("UNIQUE constraint failed");
    const rollbackFailure: object = expect.objectContaining({ message: rollbackMessage });
    const migrationFailure: object = expect.objectContaining({ message: migrationMessage });
    expect(() => Migration.applyOrdered(db, directory, [{ name: "broken.sql" }])).toThrow(
      expect.objectContaining({
        name: "SuppressedError",
        error: rollbackFailure,
        suppressed: migrationFailure,
      }),
    );
    expect(db.query("SELECT name FROM _migrations").all()).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'broken'").get()).toBeNull();
  });
});
