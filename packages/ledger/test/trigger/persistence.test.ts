import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Migration } from "../../src/storage/migration-runner";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { Storage } from "../../src/storage/storage";
import { createSqliteTriggerAdapter } from "../../src/storage/sqlite-trigger-adapter";
import { buildTriggerFire, buildTriggerRecord } from "../helpers/trigger";

const MIGRATION_DIR = resolve(import.meta.dir, "../../migration");

let directory: string;
let db: Database;

beforeEach(() => {
  Storage.reset();
  directory = mkdtempSync(join(tmpdir(), "openomni-trigger-migration-"));
  db = new Database(join(directory, "storage.db"), { create: true });
});

afterEach(() => {
  Storage.reset();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("trigger subsystem migration", () => {
  test("creates both projection tables and is idempotent", () => {
    initializeSqliteDatabase(db);
    expect(() => initializeSqliteDatabase(db)).not.toThrow();

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trigger_record', 'trigger_fire') ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(["trigger_fire", "trigger_record"]);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM _migrations WHERE name = '0030_trigger_subsystem/migration.sql'",
        )
        .all(),
    ).toEqual([{ name: "0030_trigger_subsystem/migration.sql" }]);
  });

  test("reopens persisted Trigger and Fire rows", () => {
    const path = join(directory, "reopen.db");
    const first = new SqliteStorageAdapter(path);
    expect(first.trigger.create(buildTriggerRecord())).toBe(true);
    expect(first.triggerFire.create(buildTriggerFire())).toBe(true);
    first.close();

    const reopened = new SqliteStorageAdapter(path);
    try {
      expect(reopened.trigger.get("trigger-1")).toEqual(buildTriggerRecord());
      expect(reopened.triggerFire.get("fire-1")).toEqual(buildTriggerFire());
      expect(reopened.triggerFire.listUnackedIds()).toEqual(["fire-1"]);
    } finally {
      reopened.close();
    }
  });

  test("isolates corrupt rows behind indexed boot candidate scans", () => {
    initializeSqliteDatabase(db);
    const adapter = createSqliteTriggerAdapter(db);
    expect(adapter.create(buildTriggerRecord())).toBe(true);
    expect(
      adapter.create(
        buildTriggerRecord({ id: "trigger-corrupt", createdAt: 2_000, updatedAt: 2_000 }),
      ),
    ).toBe(true);
    db.query("UPDATE trigger_record SET data = ? WHERE id = ?").run("{", "trigger-corrupt");

    expect(adapter.listActiveIds()).toEqual(["trigger-1", "trigger-corrupt"]);
    expect(adapter.get("trigger-1")).toEqual(buildTriggerRecord());
    expect(() => adapter.get("trigger-corrupt")).toThrow();
  });

  test("clear deletes Fire children before Trigger parents", () => {
    const adapter = new SqliteStorageAdapter(join(directory, "clear.db"));
    try {
      expect(adapter.trigger.create(buildTriggerRecord())).toBe(true);
      expect(adapter.triggerFire.create(buildTriggerFire())).toBe(true);
      expect(() => adapter.clear()).not.toThrow();
      expect(adapter.trigger.get("trigger-1")).toBeUndefined();
      expect(adapter.triggerFire.get("fire-1")).toBeUndefined();
    } finally {
      adapter.close();
    }
  });

  test("production completeness requires both Trigger projection capabilities", () => {
    for (const capability of ["trigger", "triggerFire"] as const) {
      const adapter = new SqliteStorageAdapter(join(directory, `${capability}.db`));
      Object.defineProperty(adapter, capability, { configurable: true, value: undefined });
      try {
        expect(() => Storage.configure(adapter)).toThrow(
          `Production storage adapter is missing required capability: ${capability}`,
        );
      } finally {
        adapter.close();
        Storage.reset();
      }
    }
  });

  test("leaves historical cron rows untouched and does not convert them", () => {
    Migration.applyOrdered(
      db,
      MIGRATION_DIR,
      shippedMigrations().filter(
        (migration) => migration.name !== "0030_trigger_subsystem/migration.sql",
      ),
    );
    db.query("INSERT INTO cron_job (id, data, time_created, time_updated) VALUES (?, ?, ?, ?)").run(
      "cron-legacy",
      '{"schedule":"0 * * * *"}',
      1,
      1,
    );

    initializeSqliteDatabase(db);

    expect(db.query("SELECT id, data FROM cron_job").all()).toEqual([
      { id: "cron-legacy", data: '{"schedule":"0 * * * *"}' },
    ]);
    expect(db.query("SELECT id FROM trigger_record").all()).toEqual([]);
    expect(db.query("SELECT id FROM trigger_fire").all()).toEqual([]);
  });
});

function shippedMigrations(): Migration.Definition[] {
  return readdirSync(MIGRATION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}_/.test(entry.name))
    .map((entry) => ({ name: `${entry.name}/migration.sql` }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
