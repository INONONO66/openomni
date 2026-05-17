import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { join } from "node:path";
import { Migration } from "../migration-runner";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATION_DIR = join(import.meta.dir, "../../../migration");

function applyMigrations(sqlite: Database): void {
  // Drizzle storage is legacy bootstrap code and only has schema definitions for the
  // original core session tables; keep its migration list intentionally bounded.
  const migrations: Migration.Definition[] = [
    { name: "0001_initial/migration.sql" },
    { name: "0002_pragma_fk_indices/migration.sql" },
    { name: "0003_new_tables/migration.sql" },
    { name: "0004_message_status/migration.sql", compatApplied: hasMessageStatusColumn },
  ];

  Migration.applyOrdered(sqlite, MIGRATION_DIR, migrations);
}

function hasMessageStatusColumn(sqlite: Database): boolean {
  const rows = sqlite.query("PRAGMA table_info(message)").all() as Array<{ name: string }>;
  return rows.some((row) => row.name === "status");
}

export function createDb(dbPath: string): { db: DrizzleDb; sqlite: Database } {
  const sqlite = new Database(dbPath);

  try {
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
  } catch (err) {
    sqlite.close();
    throw err;
  }
}
