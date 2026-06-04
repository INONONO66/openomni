import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { join } from "node:path";
import { Migration } from "../migration-runner";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATION_DIR = join(import.meta.dir, "../../../migration");

function applyMigrations(sqlite: Database): void {
  Migration.applyOrdered(sqlite, MIGRATION_DIR, [
    { name: "0001_initial/migration.sql" },
    { name: "0002_communication_state/migration.sql" },
  ]);
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
