import type { Database } from "bun:sqlite";
import { Storage } from "../storage/storage.js";
import type { PersistableAdapter } from "./types.js";

export function getDatabase(): Database {
  const adapter = Storage.getAdapter() as PersistableAdapter;
  if (adapter.db === undefined) {
    throw new Error("BusPersistence requires a SQLite-backed storage adapter");
  }
  return adapter.db;
}

export function getOptionalDatabase(): Database | undefined {
  const adapter = Storage.getAdapter() as PersistableAdapter;
  return adapter.db;
}
