import type { Database } from "bun:sqlite";
import { Storage } from "../storage/storage.js";

// Telemetry writes AND reads ride the telemetry connection (#510 D1) —
// bus_event traffic never contends with the FULL decision connection under
// WAL. The adapter's telemetryConnection() is the single sanctioned path to
// the handle; no consumer casts past the adapter's private fields.
export function getDatabase(): Database {
  const db = Storage.getAdapter().telemetryConnection?.();
  if (db === undefined) {
    throw new Error("BusPersistence requires a SQLite-backed storage adapter");
  }
  return db;
}

export function getOptionalDatabase(): Database | undefined {
  return Storage.getAdapter().telemetryConnection?.();
}
