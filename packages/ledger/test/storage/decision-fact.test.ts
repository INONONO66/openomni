import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DecisionFact } from "@openomni/protocol";
import { DecisionFacts, SqliteStorageAdapter, Storage } from "../../src/index";
import { computeDecisionFactHash } from "../../src/storage/l0-hash";
import {
  DecisionFactMigrationError,
  DECISION_FACT_MIGRATION,
  RETIRED_DECISION_TABLES,
} from "../../src/storage/decision-fact-migration";
import { Migration } from "../../src/storage/migration-runner";
import {
  initializeSqliteDatabase,
  ORDERED_MIGRATIONS,
  preflightSqliteDatabase,
} from "../../src/storage/sqlite-schema-lifecycle";
import { U967Error } from "../../src/storage/u967-preflight";
import { assertArchiveEquality } from "../../../../script/ledger-archive-snapshot";

const migrationDir = join(import.meta.dir, "../../migration");
const retiredFacts = RETIRED_DECISION_TABLES.facts;
const retiredHeads = RETIRED_DECISION_TABLES.heads;
const input = {
  key: "route:first",
  type: "route.decided",
  data: { value: "a|b" },
  timeCreated: 10,
};

afterEach(() => Storage.reset());

test("first writer wins and every outcome carries the exact recorded fact", () => {
  const adapter = new SqliteStorageAdapter(":memory:");
  Storage.configure(adapter);
  const facts = adapter.decisionFacts;
  expect(facts.head(input.key)).toBeUndefined();
  const first = facts.record(input);
  expect(first).toEqual({
    kind: "recorded",
    fact: {
      ...input,
      rowHash: computeDecisionFactHash({ ...input, data: JSON.stringify(input.data) }),
    },
  });
  expect(DecisionFact.Outcome.parse(first)).toEqual(first);
  expect(
    facts.record({ ...input, type: "other", data: { changed: true }, timeCreated: 20 }),
  ).toEqual({ kind: "exists", fact: first.fact });
  expect(facts.head(input.key)).toEqual(first.fact);
  const framed = JSON.stringify([
    input.key,
    input.type,
    JSON.stringify(input.data),
    input.timeCreated,
  ]);
  expect(first.fact.rowHash).toBe(createHash("sha256").update(framed).digest("hex"));
  for (const changed of [
    { key: "route:other" },
    { type: "other" },
    { data: "{}" },
    { timeCreated: 11 },
  ]) {
    expect(
      computeDecisionFactHash({ ...input, data: JSON.stringify(input.data), ...changed }),
    ).not.toBe(first.fact.rowHash);
  }
});

test("decision facts share the adapter transaction and roll back with it", () => {
  const adapter = new SqliteStorageAdapter(":memory:");
  Storage.configure(adapter);
  const failure = new Error("rollback");
  expect(() =>
    DecisionFacts.transaction(() => {
      expect(DecisionFacts.port()?.record(input).kind).toBe("recorded");
      throw failure;
    }),
  ).toThrow(failure);
  expect(adapter.decisionFacts.head(input.key)).toBeUndefined();
  adapter.transaction(() => expect(adapter.decisionFacts.record(input).kind).toBe("recorded"));
  expect(adapter.decisionFacts.head(input.key)?.data).toEqual(input.data);
});

function historicalDatabase() {
  const db = new Database(":memory:");
  Migration.applyOrdered(db, migrationDir, [{ name: "0013_ledger/migration.sql" }]);
  return db;
}

function seed(db: Database, key: string, seq: number) {
  db.query(
    `INSERT INTO ${retiredFacts} (stream_id, seq, type, data, prev_hash, event_hash, time_created) VALUES (?, ?, ?, ?, 'old', 'old', ?)`,
  ).run(key, seq, `fact.${seq}`, JSON.stringify({ seq }), seq * 10);
  db.query(`INSERT OR REPLACE INTO ${retiredHeads} (stream_id, head) VALUES (?, ?)`).run(key, seq);
}

test("migration re-records only each known stream's head and retires both tables atomically", () => {
  using db = historicalDatabase();
  const keys = ["route:a", "route_correction:b", "gateway_send:c"];
  for (const key of keys) {
    seed(db, key, 1);
    seed(db, key, 2);
  }
  Migration.applyOrdered(db, migrationDir, [{ name: DECISION_FACT_MIGRATION }]);
  const rows = db
    .query<{ key: string; type: string; data: string; row_hash: string; time_created: number }, []>(
      "SELECT * FROM decision_fact ORDER BY key",
    )
    .all();
  expect(rows).toEqual(
    keys
      .sort()
      .map((key) => ({
        key,
        type: "fact.2",
        data: '{"seq":2}',
        time_created: 20,
        row_hash: computeDecisionFactHash({
          key,
          type: "fact.2",
          data: '{"seq":2}',
          timeCreated: 20,
        }),
      })),
  );
  expect(
    db
      .query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?)")
      .all(retiredFacts, retiredHeads),
  ).toEqual([]);
  Migration.applyOrdered(db, migrationDir, [{ name: DECISION_FACT_MIGRATION }]);
  expect(db.query("SELECT * FROM decision_fact ORDER BY key").all()).toEqual(rows);
});

test.each([
  "other:a",
  "route",
  "route_correction",
  "gateway_send",
  "routeish:a",
])("migration refuses unrecognized stream %s without losing rows", (key) => {
  using db = historicalDatabase();
  seed(db, "route:valid", 1);
  seed(db, key, 1);
  let refused = false;
  try {
    Migration.applyOrdered(db, migrationDir, [{ name: DECISION_FACT_MIGRATION }]);
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionFactMigrationError);
    if (!(error instanceof DecisionFactMigrationError)) throw error;
    expect(error.reason).toBe("unknown_stream_class");
    expect(error.streamId).toBe(key);
    refused = true;
  }
  expect(refused).toBe(true);
  expect(db.query(`SELECT COUNT(*) AS count FROM ${retiredFacts}`).get()).toEqual({ count: 2 });
  expect(db.query(`SELECT COUNT(*) AS count FROM ${retiredHeads}`).get()).toEqual({ count: 2 });
  expect(db.query("SELECT name FROM sqlite_schema WHERE name = 'decision_fact'").all()).toEqual([]);
  expect(
    db.query("SELECT name FROM _migrations WHERE name = ?").all(DECISION_FACT_MIGRATION),
  ).toEqual([]);
});

test.each([
  "UPDATE decision_fact SET data = '{}'",
  "UPDATE decision_fact SET row_hash = 'changed'",
  "UPDATE decision_fact SET time_created = 30",
  "DELETE FROM decision_fact",
])("0040 reopens and archive verification rejects changed decision facts: %s", (mutation) => {
  using db = new Database(":memory:");
  Migration.applyOrdered(
    db,
    migrationDir,
    ORDERED_MIGRATIONS.filter((entry) => entry.name !== DECISION_FACT_MIGRATION),
  );
  seed(db, "route:archive", 1);
  seed(db, "route:archive", 2);
  const data = '{ "seq" : 2 }';
  db.query(`UPDATE ${retiredFacts} SET data = ? WHERE seq = 2`).run(data);
  using archive = Database.deserialize(db.serialize());
  expect(preflightSqliteDatabase(db)).toBe("pending");
  initializeSqliteDatabase(db);
  expect(preflightSqliteDatabase(db)).toBe("applied");
  using reopened = Database.deserialize(db.serialize());
  initializeSqliteDatabase(reopened);
  expect(reopened.query("SELECT data, row_hash FROM decision_fact").get()).toEqual({
    data,
    row_hash: computeDecisionFactHash({
      key: "route:archive",
      type: "fact.2",
      data,
      timeCreated: 20,
    }),
  });
  expect(() => assertArchiveEquality(reopened, archive, true)).not.toThrow();
  reopened.run(mutation);
  let refused = false;
  try {
    assertArchiveEquality(reopened, archive, true);
  } catch (error) {
    expect(error).toBeInstanceOf(U967Error);
    if (!(error instanceof U967Error)) throw error;
    expect(error.code).toBe("stale_archive:decision_fact");
    refused = true;
  }
  expect(refused).toBe(true);
});

test("0040 post-step is a no-op when the retired stream tables were never created", () => {
  using db = new Database(":memory:");
  Migration.applyOrdered(db, migrationDir, [{ name: DECISION_FACT_MIGRATION }]);
  expect(db.query("SELECT COUNT(*) AS count FROM decision_fact").get()).toEqual({ count: 0 });
  expect(
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
      .all(retiredFacts, retiredHeads),
  ).toEqual([]);
  Migration.applyOrdered(db, migrationDir, [{ name: DECISION_FACT_MIGRATION }]);
});

test("decision facts keep fractional epoch instants without rounding", () => {
  Storage.initialize({ dbPath: ":memory:" });
  const facts = DecisionFacts.port();
  if (facts === undefined) throw new Error("decision facts port missing");
  const outcome = facts.record({ ...input, key: "route:fractional", timeCreated: 1.5 });
  expect(outcome.kind).toBe("recorded");
  expect(outcome.fact.timeCreated).toBe(1.5);
  expect(facts.head("route:fractional")?.timeCreated).toBe(1.5);
});
