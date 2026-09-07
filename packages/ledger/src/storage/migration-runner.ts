import type { Database } from "bun:sqlite";
import { Alarm, type PlainValue } from "@openomni/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { U967Error, U967_MIGRATION } from "./u967-preflight";
import { inspect967Projections } from "./u967-projection";

export namespace Migration {
  export const Definition = z.object({
    name: z.string(),
  });

  export type Definition = z.infer<typeof Definition>;

  export type Preparation967 = (db: Database) => void;

  export function applyOrdered(db: Database, migrationDir: string, migrations: Definition[], prepare967?: Preparation967): void {
    db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");

    for (const migration of migrations.map((item) => Definition.parse(item))) {
      applyMigration(db, migrationDir, migration, prepare967);
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

const decodeJson: (text: string) => PlainValue = JSON.parse;

function validateWatchAlarms(db: Database): void {
  const rows = db.query<{ id: string; spec: string | null }, []>("SELECT id, spec FROM alarm WHERE kind = 'watch'").all();
  for (const row of rows) {
    const parsed = Alarm.WatchSpec.safeParse(row.spec === null ? null : decodeJson(row.spec));
    if (!parsed.success) throw new Error(`alarm migration refused: ${row.id}: invalid watch spec`);
  }
}

function applyMigration(db: Database, migrationDir: string, migration: Migration.Definition, prepare967?: Migration.Preparation967): void {
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  let committed = false;
  // Native disposal preserves both failures as SuppressedError if rollback
  // also throws. The caller must close and inspect this indeterminate outcome.
  using _rollback = {
    [Symbol.dispose]() {
      if (!committed) db.exec("ROLLBACK");
    },
  };
  {
    const applied = db.query<{ "1": number | bigint }, [string]>("SELECT 1 FROM _migrations WHERE name = ?").get(migration.name);
    if (!applied) {
      if (migration.name === U967_MIGRATION) {
        if (prepare967) prepare967(db);
        else {
          const projection = inspect967Projections(db, Date.now());
          if (projection.blocked.length > 0 || projection.candidates.length > 0) throw new U967Error("approval_required");
        }
      }
      if (migration.name === "0035_watch_alarms/migration.sql") validateWatchAlarms(db);
      const sql = readFileSync(join(migrationDir, migration.name), "utf-8");
      for (const statement of migrationStatements(sql)) {
        db.run(statement);
      }
      db.query("INSERT INTO _migrations (name) VALUES (?)").run(migration.name);
    }
    db.exec("COMMIT");
    committed = true;
  }
}
