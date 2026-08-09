import type { Database } from "bun:sqlite";
import { Storage } from "../storage/storage.js";
import type { PersistableAdapter } from "./types.js";

export function getDatabase(): Database {
  const adapter = Storage.getAdapter() as PersistableAdapter;
  const db = adapter.telemetryDb ?? adapter.db;
  if (db === undefined) {
    throw new Error("BusPersistence requires a SQLite-backed storage adapter");
  }
  return db;
}

export function getOptionalDatabase(): Database | undefined {
  const adapter = Storage.getAdapter() as PersistableAdapter;
  return adapter.telemetryDb ?? adapter.db;
}
