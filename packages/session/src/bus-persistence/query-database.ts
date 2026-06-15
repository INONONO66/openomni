import type { Database } from "bun:sqlite";
import { Storage } from "../storage/storage.js";

interface PersistableAdapter {
  readonly db?: Database;
}

export function getDatabase(): Database {
  const adapter = Storage.getAdapter() as PersistableAdapter;
  if (!adapter.db) throw new Error("BusQuery requires SQLite-backed storage");
  return adapter.db;
}
