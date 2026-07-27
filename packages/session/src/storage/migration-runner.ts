import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export namespace Migration {
  export const BASELINE_NAME = "0001_p2_clean_baseline/migration.sql" as const;
  export const BASELINE_ID = "p2-clean-v1" as const;
  export const SCHEMA_VERSION = 1 as const;

  export interface Definition {
    readonly name: typeof BASELINE_NAME;
  }

  /** Applies the one clean baseline atomically. The caller must first prove the schema is empty. */
  export function applyBaseline(db: Database, migrationDir: string, migration: Definition): void {
    if (migration.name !== BASELINE_NAME) {
      throw new TypeError(`Unsupported migration marker: ${migration.name}`);
    }

    const sql = readFileSync(join(migrationDir, migration.name), "utf-8");
    db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      db.exec(sql);
      db.query("INSERT INTO _migrations (name, applied_at_db_ms) VALUES (?, ?)").run(
        migration.name,
        databaseTimeMs(db),
      );
      db.query("INSERT INTO schema_meta (baseline_id, schema_version) VALUES (?, ?)").run(
        BASELINE_ID,
        SCHEMA_VERSION,
      );
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the baseline failure; SQLite may already have rolled back the transaction.
      }
      throw error;
    }
  }
}

function databaseTimeMs(db: Database): number {
  const row = db.query("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms").get() as {
    readonly now_ms: number;
  };
  return row.now_ms;
}
