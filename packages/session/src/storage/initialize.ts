import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "./storage";
import { FileStorageAdapter } from "./file-storage";
import { SqliteStorageAdapter } from "./sqlite-storage";
import { CachedStorageAdapter } from "./cache";
import { ensureGitignore } from "./gitignore";

export interface InitializeOptions {
  dir?: string;
  cwd?: string;
  lock?: boolean;
  backend?: "file" | "sqlite";
}

export function initialize(options: InitializeOptions = {}): void {
  const dir = options.dir ?? ".openomni";
  const cwd = options.cwd ?? process.cwd();
  const lock = options.lock !== false;
  const backend = options.backend ?? "sqlite";
  const fullPath = join(cwd, dir);

  mkdirSync(fullPath, { recursive: true });

  if (backend === "sqlite") {
    const dbPath = join(fullPath, "storage.db");
    const sqliteAdapter = new SqliteStorageAdapter(dbPath);
    Storage.configure(sqliteAdapter);
  } else {
    const lockDir = lock ? join(fullPath, ".lock") : undefined;
    if (lockDir) mkdirSync(lockDir, { recursive: true });
    const fileAdapter = new FileStorageAdapter(fullPath, lockDir);
    const cachedAdapter = new CachedStorageAdapter(fileAdapter);
    Storage.configure(cachedAdapter);
  }

  ensureGitignore(cwd, dir + "/");
}

declare module "./storage" {
  namespace Storage {
    function initialize(options?: InitializeOptions): void;
  }
}

(Storage as Record<string, unknown>).initialize = initialize;
