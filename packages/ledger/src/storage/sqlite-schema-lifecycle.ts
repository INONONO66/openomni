import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { Migration } from "./migration-runner";
import { preflight967, U967Error, U967_MIGRATION, REPLY_GRANT_MIGRATION } from "./u967-preflight";
import { inspect967Projections } from "./u967-projection";
import { preflight969, REQUEST_MIGRATION } from "./u969-preflight";

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
  { name: "0037_watch_alarms/migration.sql" },
  { name: REQUEST_MIGRATION },
];

export function preflightSqliteDatabase(db: Database) {
  return preflight967(db, ORDERED_MIGRATIONS);
}

export function initializeSqliteDatabase(
  db: Database,
  prepare967?: Migration.Preparation967,
  target: "current" | "archive967" = "current",
): void {
  const state = preflightSqliteDatabase(db);
  if (state === "pending" && prepare967 === undefined) {
    const projection = inspect967Projections(db, Date.now());
    if (
      projection.blocked.length > 0 ||
      projection.candidates.length > 0 ||
      db.query<{ present: number }, []>("SELECT 1 AS present FROM bus_event LIMIT 1").get() !== null
    )
      throw new U967Error("approval_required");
  }
  if (target === "current" && state !== "fresh") preflight969(db, Date.now());
  // The primary connection owns every decision-class write (ledger appends +
  // projections share its transactions), so it runs at synchronous=FULL: a
  // committed append survives power loss, which is what "no record, no
  // action" durably means (#510 D1).
  applyConnectionPragmas(db, "FULL");
  // Preserve the shipped archive chain through 0036, never authorize later migrations.
  const migrations =
    target === "current" && prepare967 === undefined
      ? ORDERED_MIGRATIONS
      : ORDERED_MIGRATIONS.slice(
          0,
          ORDERED_MIGRATIONS.findIndex((migration) => migration.name === REPLY_GRANT_MIGRATION) + 1,
        );
  Migration.applyOrdered(db, MIGRATION_DIR, migrations, prepare967);
}

function applyConnectionPragmas(db: Database, synchronous: "FULL" | "NORMAL"): void {
  for (const sql of [
    "PRAGMA journal_mode = WAL",
    `PRAGMA synchronous = ${synchronous}`,
    "PRAGMA busy_timeout = 5000",
    "PRAGMA cache_size = -64000",
    "PRAGMA mmap_size = 268435456",
    "PRAGMA temp_store = MEMORY",
    "PRAGMA foreign_keys = ON",
    "PRAGMA wal_checkpoint(PASSIVE)",
  ]) {
    // Bun 1.3.6 must not retain cached pragma cursors across the table rebuild.
    const statement = db.prepare(sql);
    try {
      statement.all();
    } finally {
      statement.finalize();
    }
  }
}
