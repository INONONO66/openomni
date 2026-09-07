import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Migration } from "../../src/storage/migration-runner";
import { U967Error } from "../../src/storage/u967-preflight";
import { createDispositionFixture } from "../helpers/disposition-967";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";
import "./u967-disposition-cases";

/**
 * Migration 0025 drops the frozen pending_ask/pending_interaction tables and
 * guards the drop with a pure-SQL CHECK(row_count = 0) insert. Bun's
 * `Database.exec` swallows mid-script statement failures (a CHECK violation
 * neither throws nor stops the following statements), so the runner executes
 * migrations one statement at a time — these tests pin that the guard
 * actually aborts on non-empty tables instead of silently destroying
 * unarchived rows, and that error propagation holds for any failing
 * migration statement.
 */

const MIGRATION_DIR = resolve(import.meta.dir, "../../migration");

function shippedMigrations(): Migration.Definition[] {
  return readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}_/.test(entry.name))
    .map((entry) => ({ name: `${entry.name}/migration.sql` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bootstrapPre0025(db: Database): void {
  const before = shippedMigrations().filter(
    (migration) => !migration.name.startsWith("0025_drop_pending_tables/"),
  );
  Migration.applyOrdered(db, MIGRATION_DIR, before);
}

function seedPendingAskRow(db: Database): void {
  db.run(
    "INSERT INTO session (id, data, time_created, time_updated) VALUES ('ses_guard', '{}', 1, 1)",
  );
  db.run(
    `INSERT INTO pending_ask (id, data, status, origin_session_id, time_created, time_updated)
     VALUES ('ask_guard', '{}', 'open', 'ses_guard', 1, 1)`,
  );
}

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "openomni-migration-guard-"));
  db = new Database(join(tmpDir, "storage.db"), { create: true });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("967 atomic disposition", () => {
  test("ordinary boot refuses nonempty retired targets without changing rows or markers", () => {
    using fixture = createDispositionFixture();
    const before = fixture.db.serialize();
    expect(() => {
      const adapter = new SqliteStorageAdapter(fixture.path);
      adapter.close();
    }).toThrow(
      expect.objectContaining({
        constructor: U967Error,
        code: "approval_required",
      }),
    );
    expect(fixture.db.serialize()).toEqual(before);
  });

  test("fresh boot drops the empty bus table and records the cutover once", () => {
    const adapter = new SqliteStorageAdapter(join(tmpDir, "fresh.sqlite"));
    adapter.close();
    using raw = new Database(join(tmpDir, "fresh.sqlite"), { readonly: true });
    expect(tableNames(raw)).not.toContain("bus_event");
    expect(raw.query("SELECT name FROM _migrations WHERE name LIKE '0035%'").all()).toEqual([
      { name: "0035_drop_retired_delegation_tables/migration.sql" },
    ]);
  });
});

describe("migration 0025 pending-table drop guard", () => {
  test("non-empty pending_ask aborts the drop, keeps the rows, and records nothing", () => {
    bootstrapPre0025(db);
    seedPendingAskRow(db);

    expect(() => initializeSqliteDatabase(db)).toThrow("unsupported_upgrade");
    expect(() =>
      Migration.applyOrdered(db, MIGRATION_DIR, [
        { name: "0025_drop_pending_tables/migration.sql" },
      ]),
    ).toThrow(/CHECK constraint failed/);

    // The wrapping transaction rolled back: rows survive, tables survive,
    // and 0025 was never recorded as applied.
    const tables = tableNames(db);
    expect(tables).toContain("pending_ask");
    expect(tables).toContain("pending_interaction");
    expect(db.query("SELECT COUNT(*) AS n FROM pending_ask").get()).toEqual({ n: 1 });
    const applied = db
      .query<{ name: string }, []>("SELECT name FROM _migrations WHERE name LIKE '0025%'")
      .all();
    expect(applied).toEqual([]);
  });

  test("empty pending tables drop cleanly and 0025 is recorded", () => {
    bootstrapPre0025(db);

    expect(() => initializeSqliteDatabase(db)).toThrow("unsupported_upgrade");
    Migration.applyOrdered(db, MIGRATION_DIR, [{ name: "0025_drop_pending_tables/migration.sql" }]);

    const tables = tableNames(db);
    expect(tables).not.toContain("pending_ask");
    expect(tables).not.toContain("pending_interaction");
    expect(tables).not.toContain("_pending_ask_drop_guard");
    expect(tables).not.toContain("_pending_interaction_drop_guard");
    expect(
      db.query<{ name: string }, []>("SELECT name FROM _migrations WHERE name LIKE '0025%'").all(),
    ).toEqual([{ name: "0025_drop_pending_tables/migration.sql" }]);
  });

  test("a failing statement in any migration propagates instead of being swallowed", () => {
    // Bun's multi-statement exec keeps running after a failed statement; the
    // runner's per-statement execution is what makes migrations fail loudly.
    // Pin the mechanism directly against a synthetic failing migration.
    const failingDir = mkdtempSync(join(tmpdir(), "openomni-failing-migration-"));
    try {
      const migration = "9999_failing/migration.sql";
      const dir = join(failingDir, "9999_failing");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "migration.sql"),
        "CREATE TABLE guard_probe (n INTEGER CHECK (n = 0));\nINSERT INTO guard_probe (n) VALUES (1);\nCREATE TABLE never_created (id TEXT);\n",
      );

      expect(() => Migration.applyOrdered(db, failingDir, [{ name: migration }])).toThrow(
        /CHECK constraint failed/,
      );
      expect(tableNames(db)).not.toContain("never_created");
    } finally {
      rmSync(failingDir, { recursive: true, force: true });
    }
  });
});
