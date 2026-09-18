import { Database } from "bun:sqlite";
import { initializeSqliteDatabase } from "../../src/storage/sqlite-schema-lifecycle";

/** In-memory database initialized through the production migration runner. */
export function openLedgerDatabase(): Database {
  const db = new Database(":memory:");
  initializeSqliteDatabase(db);
  return db;
}
