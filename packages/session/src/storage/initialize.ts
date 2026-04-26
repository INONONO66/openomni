import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Storage } from "./storage";
import { SqliteStorageAdapter } from "./sqlite-storage";

export interface InitializeOptions {
  dbPath?: string;
}

export function initialize(options?: InitializeOptions): void {
  const dbPath = options?.dbPath ?? process.env.OPENOMNI_DB_PATH ?? ":memory:";

  if (Storage.initializedDbPath !== null && Storage.initializedDbPath !== "__configured__") {
    if (Storage.initializedDbPath === dbPath) return;
    throw new Error(
      "Storage already initialized with a different dbPath. Call Storage.reset() first.",
    );
  }

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  Storage.configure(new SqliteStorageAdapter(dbPath));
  Storage.initializedDbPath = dbPath;
}

declare module "./storage" {
  namespace Storage {
    function initialize(options?: InitializeOptions): void;
  }
}

(Storage as Record<string, unknown>).initialize = initialize;
