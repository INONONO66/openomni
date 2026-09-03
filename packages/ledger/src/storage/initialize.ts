import type { ObservationSink } from "@openomni/protocol";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Storage } from "./storage";
import { SqliteStorageAdapter } from "./sqlite-storage";

export interface InitializeOptions {
  dbPath?: string;
  observationSink?: ObservationSink;
}

export function initialize(options?: InitializeOptions): void {
  // Every production caller passes an explicit dbPath (server bootstrap and
  // worker-entry resolve it from config/OPENOMNI_DB_PATH); the bare
  // `:memory:` default is only reachable from tests.
  const dbPath = options?.dbPath ?? process.env.OPENOMNI_DB_PATH ?? ":memory:";
  const initializedDbPath = Storage.getInitializedDbPath();

  if (initializedDbPath !== null && initializedDbPath !== "__configured__") {
    if (initializedDbPath === dbPath) return;
    throw new Error(
      "Storage already initialized with a different dbPath. Call Storage.reset() first.",
    );
  }

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
Storage.configure(new SqliteStorageAdapter(dbPath, options?.observationSink));
  Storage.setInitializedDbPath(dbPath);
}

declare module "./storage" {
  namespace Storage {
    function initialize(options?: InitializeOptions): void;
  }
}

(Storage as Record<string, unknown>).initialize = initialize;
