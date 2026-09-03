import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeSqliteDatabase } from "../src/storage/sqlite-schema-lifecycle";

/**
 * #502 rename proof: migration lookup is relative to `import.meta.dir` inside
 * `src/storage/sqlite-schema-lifecycle.ts` (`join(import.meta.dir,
 * "../../migration")`), so the history-preserving move of the former
 * "session" package directory to `packages/ledger` must keep resolving every
 * migration from the moved `packages/ledger/migration/` directory — no
 * hardcoded former directory anywhere on the lookup path.
 */

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "openomni-migration-resolution-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const MIGRATION_DIR = resolve(import.meta.dir, "../migration");
const RETIRED_WORK_MIGRATION = join(MIGRATION_DIR, "0030_drop_retired_tables/migration.sql");
const RETIRED_WORK_INDEXES = [
  "idx_work_item_worker_run_id",
  "idx_work_item_parent",
  "idx_work_item_session",
  "idx_work_item_assignee",
  "idx_work_item_status",
] as const;
const RETIRED_WORK_INDEX_SET: ReadonlySet<string> = new Set(RETIRED_WORK_INDEXES);

function retiredWorkIndexesIn(db: Database): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name)
    .filter((name) => RETIRED_WORK_INDEX_SET.has(name));
}

describe("moved migration resolution (#502)", () => {
  test("migration directory resolves under packages/ledger, not any former path", () => {
    expect(MIGRATION_DIR.endsWith("packages/ledger/migration")).toBe(true);
    expect(existsSync(MIGRATION_DIR)).toBe(true);
  });

  test("every numbered migration directory ships a migration.sql", () => {
    const entries = readdirSync(MIGRATION_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}_/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(entries.length).toBeGreaterThanOrEqual(18);
    for (const entry of entries) {
      expect(existsSync(join(MIGRATION_DIR, entry, "migration.sql"))).toBe(true);
    }
  });

  test("fresh sqlite bootstrap applies every moved migration via import.meta.dir lookup", () => {
    const db = new Database(join(tmpDir, "storage.db"), { create: true });
    try {
      initializeSqliteDatabase(db);

      const applied = db
        .query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY name")
        .all()
        .map((row) => row.name);

      const shipped = readdirSync(MIGRATION_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{4}_/.test(entry.name))
        .map((entry) => `${entry.name}/migration.sql`)
        .sort();

      expect(applied.sort()).toEqual(shipped);

      // Schema actually materialized — the append core's table exists.
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(tables).toContain("ledger_event");
      expect(tables).toContain("session");
      expect(tables).not.toContain("work_item");

      expect(retiredWorkIndexesIn(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("forward migration drops WorkItem tables from an upgraded database", () => {
    const db = new Database(join(tmpDir, "upgraded.db"), { create: true });
    try {
      initializeSqliteDatabase(db);
      db.exec("CREATE TABLE work_item (id TEXT PRIMARY KEY)");
      for (const index of RETIRED_WORK_INDEXES) {
        db.exec(`CREATE INDEX ${index} ON work_item(id)`);
      }
      db.query("DELETE FROM _migrations WHERE name = ?").run(
        "0030_drop_retired_tables/migration.sql",
      );
      initializeSqliteDatabase(db);
      expect(
        db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'work_item'").get(),
      ).toBeNull();
      expect(retiredWorkIndexesIn(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("forward migration explicitly drops every retired WorkItem index", () => {
    const migration = readFileSync(RETIRED_WORK_MIGRATION, "utf8");
    for (const index of RETIRED_WORK_INDEXES) {
      expect(migration).toContain(`DROP INDEX IF EXISTS ${index};`);
    }
  });

  test("bootstrap is idempotent on an already-migrated database", () => {
    const db = new Database(join(tmpDir, "storage.db"), { create: true });
    try {
      initializeSqliteDatabase(db);
      expect(() => initializeSqliteDatabase(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
