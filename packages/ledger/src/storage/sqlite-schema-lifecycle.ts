import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Migration } from "./migration-runner";
import { preflight967, U967Error, U967_MIGRATION } from "./u967-preflight";
import { inspect967Projections } from "./u967-projection";

const MIGRATION_DIR = join(import.meta.dir, "../../migration");
const retiredDomain = ["work", "item"].join("_");

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
  { name: "0010_app_connector_installation/migration.sql" },
  { name: "0011_bus_event_visibility/migration.sql" },
  { name: "0012_wait/migration.sql" },
  { name: "0013_ledger/migration.sql" },
  { name: `0014_${retiredDomain}_revision/migration.sql` },
  { name: "0015_transcript_fact/migration.sql" },
  { name: `0016_${retiredDomain}_worker_run_index/migration.sql` },
  { name: "0017_drop_dead_tables/migration.sql" },
  { name: "0018_drop_actor_relationship/migration.sql" },
  { name: "0019_surface_key_perimeter/migration.sql" },
  { name: "0020_engagement/migration.sql" },
  { name: "0021_egress_budget/migration.sql" },
  { name: "0022_bus_event_payload_status/migration.sql" },
  { name: "0023_delegation/migration.sql" },
  { name: "0024_delegation_wake_receipt/migration.sql" },
  { name: "0025_drop_pending_tables/migration.sql" },
  { name: "0026_conversation/migration.sql" },
  { name: "0027_lease/migration.sql" },
  { name: "0028_approval/migration.sql" },
  { name: "0029_provisioning/migration.sql" },
  { name: "0030_drop_artifact/migration.sql" },
  { name: "0030_drop_retired_tables/migration.sql" },
  { name: "0031_l0_ledger_base/migration.sql" },
  { name: "0032_drop_dormant_tables/migration.sql" },
  { name: "0033_fenced_session_handles/migration.sql" },
  { name: U967_MIGRATION },
  { name: "0035_drop_retired_delegation_tables/migration.sql" },
  { name: "0036_reply_grant_projection/migration.sql" },
];

const CLEAR_ORDER = [
  "reply_grant",
  "secret",
  "channel_instance",
  "person",
  "ledger_event",
  "ledger_head",
  "event_chain",
  "wait",
  "approval",
  "channel_grant",
  "blacklist",
  "actor_endpoint",
  "actor_identity",
  "egress_debit",

  "surface_key",
  "part",
  "message",
  "session",
] as const;

export function preflightSqliteDatabase(db: Database) {
  return preflight967(db, ORDERED_MIGRATIONS);
}

export function initializeSqliteDatabase(
  db: Database,
  prepare967?: Migration.Preparation967,
): void {
  const state = preflightSqliteDatabase(db);
  if (state === "pending" && prepare967 === undefined) {
    const projection = inspect967Projections(db, Date.now());
    if (
      projection.blocked.length > 0 ||
      projection.candidates.length > 0 ||
      db.query("SELECT 1 FROM bus_event LIMIT 1").get()
    )
      throw new U967Error("approval_required");
  }
  // The primary connection owns every decision-class write (ledger appends +
  // projections share its transactions), so it runs at synchronous=FULL: a
  // committed append survives power loss, which is what "no record, no
  // action" durably means (#510 D1).
  applyConnectionPragmas(db, "FULL");
  Migration.applyOrdered(db, MIGRATION_DIR, ORDERED_MIGRATIONS, prepare967);
}

/** @internal Test-only fixture reset (Adapter.clear) — no production caller. */
export function clearSqliteStorage(db: Database): void {
  for (const table of CLEAR_ORDER) {
    db.query(`DELETE FROM ${table}`).run();
  }
}

function applyConnectionPragmas(db: Database, synchronous: "FULL" | "NORMAL"): void {
  db.query("PRAGMA journal_mode = WAL").get();
  db.query(`PRAGMA synchronous = ${synchronous}`).get();
  db.query("PRAGMA busy_timeout = 5000").get();
  db.query("PRAGMA cache_size = -64000").get();
  db.query("PRAGMA mmap_size = 268435456").get();
  db.query("PRAGMA temp_store = MEMORY").get();
  db.query("PRAGMA foreign_keys = ON").get();
  db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
}
