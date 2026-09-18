import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { LedgerAction, LedgerSession } from "@openomni/protocol";
import { SessionHandleStore, SqliteStorageAdapter, Storage } from "../../src/index";
import {
  ACTION_HASH_MIGRATION,
  ActionChainMigrationError,
  computeActionHash,
  GENESIS_PREV_HASH,
} from "../../src/storage/l0-hash";
import { Migration } from "../../src/storage/migration-runner";
import { ActionSqlRow } from "../../src/storage/sqlite-l0-rows";
import {
  ORDERED_MIGRATIONS,
  initializeSqliteDatabase,
  preflightSqliteDatabase,
} from "../../src/storage/sqlite-schema-lifecycle";
import { assertArchiveEquality } from "../../../../script/ledger-archive-snapshot";
import { createActions } from "../../src/storage/sqlite-l0-actions";

const migrationDir = join(import.meta.dir, "../../migration");
const migrationName = ACTION_HASH_MIGRATION;

afterEach(() => Storage.reset());

function append(id: string, sessionId = "chain"): LedgerAction.Append {
  return {
    id,
    sessionId,
    parentId: null,
    kind: "tool",
    intent: { encodingVersion: 1, value: { text: "a|b", nested: [1, null] } },
    effect: { encodingVersion: 1, value: { result: id } },
    irreversible: true,
    ts: 10,
  };
}

function fresh() {
  const adapter = new SqliteStorageAdapter(":memory:");
  Storage.configure(adapter);
  adapter.sessions.create(
    LedgerSession.Row.parse({
      id: "chain",
      parentId: null,
      role: "resident",
      leaseOwner: null,
      leaseFence: 0,
      leaseExpiresAt: null,
      revision: 0,
      state: "idle",
    }),
  );
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    expect(adapter.actions.append(append(`a${ordinal}`), ordinal - 1)?.revision).toBe(ordinal);
  }
  return adapter;
}

function stored(db: Database, ordinal: number) {
  return ActionSqlRow.parse(
    db.query("SELECT * FROM action WHERE session_id = 'chain' AND ordinal = ?").get(ordinal),
  );
}

function broken(ordinal: number) {
  const verdict = LedgerAction.ChainVerdict.parse(SessionHandleStore.verifyChain("chain"));
  expect(verdict.kind).toBe("broken");
  if (verdict.kind !== "broken") throw new Error("expected broken chain");
  expect(verdict.ordinal).toBe(ordinal);
  expect(verdict.expected).not.toBe(verdict.actual);
  return verdict;
}

test("empty action chain has no head", () => {
  Storage.initialize({ dbPath: ":memory:" });
  expect(SessionHandleStore.verifyChain("empty")).toEqual({
    kind: "intact",
    head: null,
    length: 0,
  });
});

test("three committed actions bind every stored field and expose their hashes", () => {
  const adapter = fresh();
  const db = adapter.testDatabase();
  const first = stored(db, 1);
  const head = stored(db, 3);
  const framed = JSON.stringify([
    GENESIS_PREV_HASH,
    first.id,
    first.parent_id,
    first.session_id,
    first.kind,
    first.intent,
    first.effect,
    first.revert,
    first.irreversible,
    first.encoding_version,
    first.ts,
    first.ordinal,
  ]);
  expect(first.action_hash).toBe(createHash("sha256").update(framed).digest("hex"));
  expect(first.prev_hash).toBe(GENESIS_PREV_HASH);
  expect(SessionHandleStore.verifyChain("chain")).toEqual({
    kind: "intact",
    length: 3,
    head: computeActionHash(head),
  });
  expect(adapter.actions.tree("chain")[2]).toMatchObject({
    prevHash: head.prev_hash,
    actionHash: head.action_hash,
  });
  expect(adapter.actions.range("chain", 2, 1)[0]).toMatchObject({
    prevHash: head.prev_hash,
    actionHash: head.action_hash,
  });
});

test("effect tampering breaks at ordinal two", () => {
  const db = fresh().testDatabase();
  db.run("UPDATE action SET effect = ? WHERE ordinal = 2", ['{ "tampered": true }']);
  const verdict = broken(2);
  expect(verdict.expected).toBe(computeActionHash(stored(db, 2)));
  expect(verdict.actual).toBe(stored(db, 2).action_hash);
});

test("swapping ordinals two and three breaks the chain", () => {
  const db = fresh().testDatabase();
  db.run("UPDATE action SET ordinal = 4 WHERE ordinal = 2");
  db.run("UPDATE action SET ordinal = 2 WHERE ordinal = 3");
  db.run("UPDATE action SET ordinal = 3 WHERE ordinal = 4");
  broken(2);
});

test("rewriting a row hash cannot conceal a broken link to its successor", () => {
  const db = fresh().testDatabase();
  db.run("UPDATE action SET effect = '{}' WHERE ordinal = 2");
  db.run("UPDATE action SET action_hash = ? WHERE ordinal = 2", [computeActionHash(stored(db, 2))]);
  expect(broken(3)).toEqual({
    kind: "broken",
    ordinal: 3,
    expected: stored(db, 2).action_hash,
    actual: stored(db, 3).prev_hash,
  });
});

for (const column of ["prev_hash", "action_hash"] as const) {
  test(`null ${column} fails verification`, () => {
    const db = fresh().testDatabase();
    db.run(`UPDATE action SET ${column} = NULL WHERE ordinal = 2`);
    expect(broken(2).actual).toBe("null");
  });
}

test("append uses the actual head hash rather than revision minus one", () => {
  const adapter = fresh();
  const db = adapter.testDatabase();
  const head = stored(db, 3).action_hash;
  db.run("UPDATE session SET revision = 8 WHERE id = 'chain'");
  const receipt = adapter.actions.append(append("after-gap"), 8);
  expect(receipt?.action.prevHash).toBe(head);
  expect(stored(db, 9).prev_hash).toBe(head);
});

test("revertible rows hash the stored revert bytes", () => {
  const adapter = fresh();
  const action = append("revert");
  const receipt = adapter.actions.append(
    {
      id: action.id,
      sessionId: action.sessionId,
      parentId: "a3",
      kind: action.kind,
      intent: action.intent,
      effect: action.effect,
      ts: action.ts,
      revert: { encodingVersion: 1, value: { undo: "a3" } },
    },
    3,
  );
  expect(receipt?.action.actionHash).toBe(computeActionHash(stored(adapter.testDatabase(), 4)));
  expect(SessionHandleStore.verifyChain("chain").kind).toBe("intact");
});

function historical() {
  const db = new Database(":memory:");
  const before = ORDERED_MIGRATIONS.slice(
    0,
    ORDERED_MIGRATIONS.findIndex(({ name }) => name === migrationName),
  );
  Migration.applyOrdered(db, migrationDir, before);
  for (const id of ["one", "two"]) {
    db.run(
      "INSERT INTO session (id, data, time_created, time_updated, role) VALUES (?, '{}', 0, 0, 'resident')",
      [id],
    );
  }
  return db;
}

function legacyAction(db: Database, sessionId: string, ordinal: number) {
  db.run(
    `INSERT INTO action (id, parent_id, session_id, kind, intent, effect, revert, irreversible, encoding_version, ts, ordinal)
    VALUES (?, NULL, ?, 'tool', ?, ?, NULL, 1, 1, 10, ?)`,
    [`${sessionId}:${ordinal}`, sessionId, '{ "b": 2, "a": 1 }', '{ "ok": true }', ordinal],
  );
}

test("0039 backfills both sessions without re-encoding JSON and creates the unique index", () => {
  using db = historical();
  for (const sessionId of ["one", "two"]) {
    legacyAction(db, sessionId, 1);
    legacyAction(db, sessionId, 2);
  }
  const before = db.query("SELECT id, intent, effect FROM action ORDER BY id").all();
  Migration.applyOrdered(db, migrationDir, ORDERED_MIGRATIONS);
  const actions = createActions(db, (operation) => db.transaction(operation)(), {
    publish: () => undefined,
  });
  for (const sessionId of ["one", "two"]) {
    const rows = ActionSqlRow.array().parse(
      db.query("SELECT * FROM action WHERE session_id = ? ORDER BY ordinal").all(sessionId),
    );
    const head = ActionSqlRow.parse(rows[1]);
    expect(actions.verifyChain(sessionId)).toEqual({
      kind: "intact",
      length: 2,
      head: computeActionHash(head),
    });
    expect(rows[0]?.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(rows[1]?.prev_hash).toBe(rows[0]?.action_hash);
  }
  expect(db.query("SELECT id, intent, effect FROM action ORDER BY id").all()).toEqual(before);
  expect(db.query("PRAGMA index_list(action)").all()).toContainEqual(
    expect.objectContaining({ name: "action_hash_unique", unique: 1 }),
  );
  expect(() =>
    db.run(
      "UPDATE action SET action_hash = (SELECT action_hash FROM action WHERE id = 'one:1') WHERE id = 'two:1'",
    ),
  ).toThrow();
  const hashes = db.query("SELECT prev_hash, action_hash FROM action ORDER BY id").all();
  Migration.applyOrdered(db, migrationDir, ORDERED_MIGRATIONS);
  expect(db.query("SELECT prev_hash, action_hash FROM action ORDER BY id").all()).toEqual(hashes);
});

test("0038 reopens pending and upgrades to an intact, applied 0039 chain", () => {
  using historicalDb = historical();
  legacyAction(historicalDb, "one", 1);
  legacyAction(historicalDb, "one", 2);
  using db = Database.deserialize(historicalDb.serialize());
  expect(preflightSqliteDatabase(db)).toBe("pending");
  initializeSqliteDatabase(db);
  using reopened = Database.deserialize(db.serialize());
  expect(preflightSqliteDatabase(reopened)).toBe("applied");
  initializeSqliteDatabase(reopened);
  const actions = createActions(reopened, (operation) => operation(), { publish: () => undefined });
  const head = ActionSqlRow.parse(reopened.query("SELECT * FROM action WHERE ordinal = 2").get());
  expect(actions.verifyChain("one")).toEqual({
    kind: "intact",
    length: 2,
    head: computeActionHash(head),
  });
});

for (const mutation of [
  "UPDATE action SET intent = '{\"changed\":1}'",
  "UPDATE action SET effect = '{\"changed\":1}'",
  "UPDATE action SET prev_hash = 'changed'",
  "UPDATE action SET action_hash = 'changed'",
  "DROP INDEX action_hash_unique",
]) {
  test(`0039 archive compatibility preserves old bytes and validates hashes: ${mutation}`, () => {
    using db = historical();
    legacyAction(db, "one", 1);
    using archived = Database.deserialize(db.serialize());
    initializeSqliteDatabase(db);
    expect(() => assertArchiveEquality(db, archived, true)).not.toThrow();
    db.run(mutation);
    expect(() => assertArchiveEquality(db, archived, true)).toThrow();
  });
}

for (const column of ["intent", "effect"] as const) {
  test(`0039 archive comparison rejects changed ${column} even with a recomputed intact chain`, () => {
    using db = historical();
    legacyAction(db, "one", 1);
    using archived = Database.deserialize(db.serialize());
    initializeSqliteDatabase(db);
    db.run(`UPDATE action SET ${column} = '{"changed":1}'`);
    const row = ActionSqlRow.parse(db.query("SELECT * FROM action").get());
    db.run("UPDATE action SET action_hash = ?", [computeActionHash(row)]);
    const actions = createActions(db, (operation) => operation(), { publish: () => undefined });
    expect(actions.verifyChain("one").kind).toBe("intact");
    expect(() => assertArchiveEquality(db, archived, true)).toThrow("stale_archive:action");
  });
}

for (const ordinals of [[1, 3], [2]]) {
  test(`0039 refuses non-contiguous ordinals ${ordinals.join(",")} and rolls back`, () => {
    using db = historical();
    legacyAction(db, "one", 1);
    for (const ordinal of ordinals) legacyAction(db, "two", ordinal);
    db.run(`CREATE TRIGGER refuse_action_update BEFORE UPDATE ON action
      BEGIN SELECT RAISE(ABORT, 'unexpected_action_update'); END`);
    const before = db.serialize();
    expect(() => Migration.applyOrdered(db, migrationDir, ORDERED_MIGRATIONS)).toThrow(
      ActionChainMigrationError,
    );
    try {
      Migration.applyOrdered(db, migrationDir, ORDERED_MIGRATIONS);
      throw new Error("expected migration refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ActionChainMigrationError);
      if (!(error instanceof ActionChainMigrationError)) throw error;
      expect(error.reason).toBe("non_contiguous_ordinal");
      expect(error.sessionId).toBe("two");
    }
    expect(db.serialize()).toEqual(before);
    expect(db.query("SELECT name FROM _migrations WHERE name = ?").get(migrationName)).toBeNull();
  });
}
