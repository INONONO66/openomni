import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export namespace Migration {
  export const Definition = z.object({
    name: z.string(),
  });

  export type Definition = z.infer<typeof Definition>;

  export function applyOrdered(db: Database, migrationDir: string, migrations: Definition[]): void {
    db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");

    for (const migration of migrations.map((item) => Definition.parse(item))) {
      applyMigration(db, migrationDir, migration);
    }
  }
}

// Bun's `Database.exec`/`run` swallow a mid-script statement failure and keep
// executing the remaining statements (verified against bun 1.4.0: a CHECK
// violation inside a multi-statement script neither throws nor stops the
// following DROPs). Migrations therefore run one statement at a time so every
// failure propagates and rolls the wrapping transaction back. Splitting on
// `;` is sound for this corpus: migration files are repo-controlled flat DDL
// with full-line comments only — no triggers, no inline comments, no string
// literals containing semicolons.
function migrationStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function applyMigration(db: Database, migrationDir: string, migration: Migration.Definition): void {
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    const applied = db.query("SELECT 1 FROM _migrations WHERE name = ?").get(migration.name);
    if (!applied) {
      const sql = readFileSync(join(migrationDir, migration.name), "utf-8");
      for (const statement of migrationStatements(sql)) {
        db.run(statement);
      }
      db.query("INSERT INTO _migrations (name) VALUES (?)").run(migration.name);
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
