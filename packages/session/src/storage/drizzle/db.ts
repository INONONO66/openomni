import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATION_DIR = join(import.meta.dir, "../../../migration");

function applyMigrations(sqlite: Database): void {
  sqlite.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");

  const migrations = [
    "0001_initial/migration.sql",
    "0002_pragma_fk_indices/migration.sql",
    "0003_new_tables/migration.sql",
    "0004_message_status/migration.sql",
  ];

  for (const migration of migrations) {
    const applied = sqlite.query("SELECT 1 FROM _migrations WHERE name = ?").get(migration);
    if (applied) continue;
    if (migration === "0004_message_status/migration.sql" && hasMessageStatusColumn(sqlite)) {
      sqlite.exec(`INSERT INTO _migrations (name) VALUES ('${migration}')`);
      continue;
    }
    const migrationSql = readFileSync(join(MIGRATION_DIR, migration), "utf-8");
    sqlite.exec(migrationSql);
    sqlite.exec(`INSERT INTO _migrations (name) VALUES ('${migration}')`);
  }
}

function hasMessageStatusColumn(sqlite: Database): boolean {
  const rows = sqlite.query("PRAGMA table_info(message)").all() as Array<{ name: string }>;
  return rows.some((row) => row.name === "status");
}

export function createDb(dbPath: string): { db: DrizzleDb; sqlite: Database } {
  const sqlite = new Database(dbPath);

  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA synchronous = NORMAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("PRAGMA cache_size = -64000");
  sqlite.exec("PRAGMA mmap_size = 268435456");
  sqlite.exec("PRAGMA temp_store = MEMORY");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA wal_autocheckpoint = 1000");

  applyMigrations(sqlite);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
