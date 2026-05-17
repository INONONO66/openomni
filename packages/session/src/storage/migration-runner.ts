import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export namespace Migration {
  export const Definition = z.object({
    name: z.string(),
    compatApplied: z.function().args(z.custom<Database>()).returns(z.boolean()).optional(),
    compatInsert: z.enum(["insert", "insertOrIgnore"]).optional(),
  });

  export type Definition = z.infer<typeof Definition>;

  export function applyOrdered(db: Database, migrationDir: string, migrations: Definition[]): void {
    db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");

    for (const migration of migrations.map((item) => Definition.parse(item))) {
      applyMigration(db, migrationDir, migration);
    }
  }
}

function applyMigration(db: Database, migrationDir: string, migration: Migration.Definition): void {
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const applied = db.query("SELECT 1 FROM _migrations WHERE name = ?").get(migration.name);
    if (!applied) {
      if (migration.compatApplied?.(db)) {
        insertMigrationMarker(db, migration.name, migration.compatInsert ?? "insert");
      } else {
        const sql = readFileSync(join(migrationDir, migration.name), "utf-8");
        db.exec(sql);
        insertMigrationMarker(db, migration.name, "insert");
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (_rollbackErr) {
      void _rollbackErr;
    }
    throw err;
  }
}

function insertMigrationMarker(
  db: Database,
  migrationName: string,
  conflictMode: "insert" | "insertOrIgnore",
): void {
  const sql =
    conflictMode === "insertOrIgnore"
      ? "INSERT OR IGNORE INTO _migrations (name) VALUES (?)"
      : "INSERT INTO _migrations (name) VALUES (?)";
  db.query(sql).run(migrationName);
}
