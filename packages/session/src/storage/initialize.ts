import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createWorkItemCompletionWriter } from "../work-item/completion-writer.js";
import { Storage } from "./storage";
import { SqliteStorageAdapter } from "./sqlite-storage";

export interface InitializeOptions {
  dbPath?: string;
}

export function initialize(options?: InitializeOptions): Storage.WorkItemCompletionWriter {
  // Every production caller passes an explicit dbPath (server bootstrap and
  // worker-entry resolve it from config/OPENOMNI_DB_PATH); the bare
  // `:memory:` default is only reachable from tests.
  const dbPath = options?.dbPath ?? process.env.OPENOMNI_DB_PATH ?? ":memory:";
  const initializedDbPath = Storage.getInitializedDbPath();

  if (initializedDbPath !== null && initializedDbPath !== "__configured__") {
    if (initializedDbPath === dbPath) {
      return createWorkItemCompletionWriter(() => Storage.get());
    }
    throw new Error(
      "Storage already initialized with a different dbPath. Call Storage.reset() first.",
    );
  }

  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const completionWriter = Storage.configure(new SqliteStorageAdapter(dbPath));
  Storage.setInitializedDbPath(dbPath);
  return completionWriter;
}

declare module "./storage" {
  namespace Storage {
    function initialize(options?: InitializeOptions): WorkItemCompletionWriter;
  }
}

(Storage as Record<string, unknown>).initialize = initialize;
