import { Database, type Database as DatabaseType } from "bun:sqlite";
import { join, resolve } from "node:path";
import { Migration } from "./migration-runner";

const MIGRATION_DIR = join(import.meta.dir, "../../migration");
const BASELINE: Migration.Definition = { name: Migration.BASELINE_NAME };

export const FINAL_APPLICATION_TABLES = [
  "_migrations",
  "schema_meta",
  "ledger_event",
  "ledger_head",
  "ledger_request",
  "projection_checkpoint",
  "session_projection",
  "message_projection",
  "part_projection",
  "surface_binding_projection",
  "artifact_reference_projection",
  "actor_identity_projection",
  "actor_endpoint_projection",
  "blacklist_projection",
  "channel_grant_projection",
  "worker_grant_projection",
  "schedule_projection",
  "connector_installation_projection",
  "work_projection",
  "attempt_projection",
  "wait_projection",
  "dispatch_projection",
  "completion_projection",
  "effect_projection",
  "artifact_blob",
] as const;

const CLEAR_ORDER = [
  "effect_projection",
  "completion_projection",
  "dispatch_projection",
  "wait_projection",
  "attempt_projection",
  "work_projection",
  "connector_installation_projection",
  "schedule_projection",
  "worker_grant_projection",
  "channel_grant_projection",
  "blacklist_projection",
  "actor_endpoint_projection",
  "actor_identity_projection",
  "artifact_reference_projection",
  "surface_binding_projection",
  "part_projection",
  "message_projection",
  "session_projection",
  "projection_checkpoint",
  "ledger_request",
  "ledger_head",
  "ledger_event",
  "artifact_blob",
] as const;

export function initializeSqliteDatabase(db: DatabaseType): void {
  const dbPath = explicitDatabasePath(db.filename);
  const classification = classifyReadOnly(db, dbPath);

  if (classification === "empty") {
    Migration.applyBaseline(db, MIGRATION_DIR, BASELINE);
  } else if (classification === "unsupported") {
    throw new Error(unsupportedSchemaMessage(dbPath));
  }

  applyRuntimePragmas(db);
}

export function clearSqliteStorage(db: DatabaseType): void {
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const table of CLEAR_ORDER) {
      db.query(`DELETE FROM ${table}`).run();
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

type SchemaClassification = "empty" | "recognized" | "unsupported";

function classifyReadOnly(db: DatabaseType, dbPath: string): SchemaClassification {
  if (dbPath === ":memory:") return classifyConnection(db);

  const classifier = new Database(dbPath, { readonly: true, strict: true });
  try {
    return classifyConnection(classifier);
  } finally {
    classifier.close();
  }
}

function classifyConnection(db: DatabaseType): SchemaClassification {
  const manifest = readManifest(db);
  if (manifest.length === 0) return "empty";
  return isRecognizedBaseline(db, manifest) ? "recognized" : "unsupported";
}

function isRecognizedBaseline(db: DatabaseType, actualManifest: readonly SchemaObject[]): boolean {
  if (!manifestsEqual(actualManifest, expectedManifest())) return false;

  const migrations = db.query("SELECT name FROM _migrations ORDER BY name").all() as {
    readonly name: string;
  }[];
  if (migrations.length !== 1 || migrations[0]?.name !== Migration.BASELINE_NAME) return false;

  const metadata = db.query("SELECT baseline_id, schema_version FROM schema_meta").all() as {
    readonly baseline_id: string;
    readonly schema_version: number;
  }[];
  return (
    metadata.length === 1 &&
    metadata[0]?.baseline_id === Migration.BASELINE_ID &&
    metadata[0]?.schema_version === Migration.SCHEMA_VERSION
  );
}

let baselineManifest: readonly SchemaObject[] | undefined;

function expectedManifest(): readonly SchemaObject[] {
  if (baselineManifest !== undefined) return baselineManifest;

  const reference = new Database(":memory:", { strict: true });
  try {
    Migration.applyBaseline(reference, MIGRATION_DIR, BASELINE);
    baselineManifest = readManifest(reference);
    return baselineManifest;
  } finally {
    reference.close();
  }
}

function readManifest(db: DatabaseType): readonly SchemaObject[] {
  return db
    .query(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY type, name`,
    )
    .all() as SchemaObject[];
}

function manifestsEqual(
  actual: readonly SchemaObject[],
  expected: readonly SchemaObject[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((item, index) => {
    const candidate = expected[index];
    return (
      candidate !== undefined &&
      item.type === candidate.type &&
      item.name === candidate.name &&
      item.tbl_name === candidate.tbl_name &&
      item.sql === candidate.sql
    );
  });
}

function explicitDatabasePath(filename: string): string {
  return filename === ":memory:" ? filename : resolve(filename);
}

function unsupportedSchemaMessage(dbPath: string): string {
  return `Unsupported database schema at "${dbPath}".\nOpenOmni P2 clean baseline "${Migration.BASELINE_ID}" does not migrate existing databases.\nStop OpenOmni, delete "${dbPath}", "${dbPath}-wal", and "${dbPath}-shm", then restart to initialize a new database.`;
}

function applyRuntimePragmas(db: DatabaseType): void {
  db.query("PRAGMA journal_mode = WAL").get();
  db.query("PRAGMA synchronous = FULL").get();
  db.query("PRAGMA foreign_keys = ON").get();
  db.query("PRAGMA busy_timeout = 5000").get();
}

interface SchemaObject {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
}
