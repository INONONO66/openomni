import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Storage } from "./storage";
import { SqliteStorageAdapter } from "./sqlite-storage";

export interface InitializeOptions {
  dbPath: string;
}

export function initialize(options: InitializeOptions): void {
  const dbPath = options.dbPath;

  mkdirSync(dirname(dbPath), { recursive: true });
  Storage.configure(new SqliteStorageAdapter(dbPath));
}

declare module "./storage" {
  namespace Storage {
    function initialize(options?: InitializeOptions): void;
  }
}

(Storage as Record<string, unknown>).initialize = initialize;
