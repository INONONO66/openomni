import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Migration } from "./migration-runner";

const MIGRATION_DIR = join(import.meta.dir, "../../migration");

const ORDERED_MIGRATIONS: Migration.Definition[] = [
  { name: "0001_initial/migration.sql" },
  { name: "0002_communication_state/migration.sql" },
  { name: "0003_communication_state_constraints/migration.sql" },
  { name: "0004_cron_job/migration.sql" },
  { name: "0005_worker_run_executor_kind/migration.sql" },
  { name: "0006_actor_registry/migration.sql" },
  { name: "0007_blacklist/migration.sql" },
  { name: "0008_channel_grant/migration.sql" },
  { name: "0009_pending_interaction/migration.sql" },
];

const CLEAR_ORDER = [
  "event_chain",
  "channel_grant",
  "blacklist",
  "actor_endpoint",
  "actor_identity",
  "cron_job",
  "pending_interaction",
  "worker_grant",
  "pending_ask",
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
