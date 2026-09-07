import type { Database } from "bun:sqlite";
import { Alarm, type PlainValue } from "@openomni/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { U967Error, U967_MIGRATION } from "./u967-preflight";
import { inspect967Projections } from "./u967-projection";
import { preflight969, REQUEST_MIGRATION } from "./u969-preflight";

export namespace Migration {
  export const Definition = z.object({
    name: z.string(),
  });

  export type Definition = z.infer<typeof Definition>;

  export type Preparation967 = (db: Database) => void;

  export function applyOrdered(
    db: Database,
    migrationDir: string,
    migrations: Definition[],
    prepare967?: Preparation967,
  ): void {
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
// failure propagates and rolls the wrapping transaction back.
// The repo-controlled corpus has no semicolons in literals. Trigger bodies
// end with END; and must reach SQLite as a single statement.
function migrationStatements(sql: string): string[] {
  const parts = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const statements: string[] = [];
  let trigger = "";
  for (const part of parts) {
    if (trigger || part.startsWith("CREATE TRIGGER")) {
      trigger += `${part};`;
      if (!part.endsWith("END")) continue;
      statements.push(trigger);
      trigger = "";
    } else statements.push(part);
  }
  if (trigger) throw new Error("unterminated migration trigger");
  return statements;
}

const decodeJson: (text: string) => PlainValue = JSON.parse;

function validateWatchAlarms(db: Database): void {
  const rows = db
    .query<{ id: string; spec: string | null }, []>(
      "SELECT id, spec FROM alarm WHERE kind = 'watch'",
    )
    .all();
  for (const row of rows) {
    const parsed = Alarm.WatchSpec.safeParse(row.spec === null ? null : decodeJson(row.spec));
    if (!parsed.success) throw new Error(`alarm migration refused: ${row.id}: invalid watch spec`);
  }
}

function prepareArchiveDisposition(db: Database, prepare967?: Migration.Preparation967): void {
  if (prepare967) {
    prepare967(db);
    return;
  }
  const projection = inspect967Projections(db, Date.now());
  if (projection.blocked.length > 0 || projection.candidates.length > 0)
    throw new U967Error("approval_required");
}

function applyMigration(
  db: Database,
  migrationDir: string,
  migration: Migration.Definition,
  prepare967?: Migration.Preparation967,
): void {
  const rebuild = migration.name === REQUEST_MIGRATION;
  const foreignKeys = db.query<{ foreign_keys: number | bigint }, []>("PRAGMA foreign_keys").all()[0]?.foreign_keys;
  // SQLite's table rebuild protocol disables FK actions before BEGIN. Check
  // every reference before COMMIT and restore the connection setting on exit.
  if (rebuild) db.run("PRAGMA foreign_keys = OFF");
  using _foreignKeys = {
    [Symbol.dispose]() {
      if (rebuild && Number(foreignKeys) === 1) db.run("PRAGMA foreign_keys = ON");
    },
  };
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
    const applied = db
      .query<{ "1": number | bigint }, [string]>("SELECT 1 FROM _migrations WHERE name = ?")
      .get(migration.name);
    if (!applied) {
      if (rebuild) preflight969(db, Date.now());
      if (migration.name === U967_MIGRATION) prepareArchiveDisposition(db, prepare967);
      if (migration.name === "0037_watch_alarms/migration.sql") validateWatchAlarms(db);
      const sql = readFileSync(join(migrationDir, migration.name), "utf-8");
      for (const statement of migrationStatements(sql)) {
        db.run(statement);
      }
      if (rebuild && db.query("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("request_migration_foreign_key_violation");
      }
      db.query("INSERT INTO _migrations (name) VALUES (?)").run(migration.name);
    }
    db.exec("COMMIT");
    committed = true;
  }
}
