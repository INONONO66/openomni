import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Migration } from "./migration-runner";

const MIGRATION_DIR = join(import.meta.dir, "../../migration");

const ORDERED_MIGRATIONS: Migration.Definition[] = [{ name: "0001_initial/migration.sql" }];

const CLEAR_ORDER = [
  "event_chain",
  "worker_run_state",
  "bus_event",
  "background_task",
  "work_item",
  "todo",
  "plan",
  "task",
  "artifact",
  "surface_key",
  "part",
  "message",
  "session",
] as const;

export function initializeSqliteDatabase(db: Database): void {
  applyPragmas(db);
  Migration.applyOrdered(db, MIGRATION_DIR, ORDERED_MIGRATIONS);
}

export function clearSqliteStorage(db: Database): void {
  for (const table of CLEAR_ORDER) {
    db.query(`DELETE FROM ${table}`).run();
  }
}

function applyPragmas(db: Database): void {
  db.query("PRAGMA journal_mode = WAL").get();
  db.query("PRAGMA synchronous = NORMAL").get();
  db.query("PRAGMA busy_timeout = 5000").get();
  db.query("PRAGMA cache_size = -64000").get();
  db.query("PRAGMA mmap_size = 268435456").get();
  db.query("PRAGMA temp_store = MEMORY").get();
  db.query("PRAGMA foreign_keys = ON").get();
  db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
}
