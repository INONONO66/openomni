import type { Database } from "bun:sqlite";
import { Storage } from "../storage/storage.js";

interface PersistableAdapter {
  readonly db?: Database;
  readonly telemetryDb?: Database;
}

// Telemetry reads ride the telemetry connection (#510 D1) — bus_event
// queries never contend with the FULL decision connection under WAL.
export function getDatabase(): Database {
  const adapter = Storage.getAdapter() as PersistableAdapter;
  const db = adapter.telemetryDb ?? adapter.db;
  if (!db) throw new Error("BusQuery requires SQLite-backed storage");
  return db;
}
