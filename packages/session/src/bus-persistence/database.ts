import type { Database } from "bun:sqlite";
import { Storage } from "../storage/storage.js";
import type { PersistableAdapter } from "./types.js";

// Telemetry writes AND reads ride the telemetry connection (#510 D1) —
// bus_event traffic never contends with the FULL decision connection under
// WAL. (merged from query-database.ts: the query-side accessor was the same
// handle with the same fallback.)
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
