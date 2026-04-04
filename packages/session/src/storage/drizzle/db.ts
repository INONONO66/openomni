import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATION_DIR = join(import.meta.dir, "../../../migration");

function applyMigrations(sqlite: Database): void {
  const migrationSql = readFileSync(join(MIGRATION_DIR, "0001_initial/migration.sql"), "utf-8");
  sqlite.exec(migrationSql);
}

export function createDb(dbPath: string): { db: DrizzleDb; sqlite: Database } {
  const sqlite = new Database(dbPath);

  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = NORMAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");

  applyMigrations(sqlite);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
