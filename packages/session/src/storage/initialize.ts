import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Storage } from "./storage";
import { FileStorageAdapter } from "./file-storage";
import { CachedStorageAdapter } from "./cache";
import { ensureGitignore } from "./gitignore";

export interface InitializeOptions {
  dir?: string;
  cwd?: string;
  lock?: boolean;
}

export function initialize(options: InitializeOptions = {}): void {
  const dir = options.dir ?? ".openomni";
  const cwd = options.cwd ?? process.cwd();
  const lock = options.lock !== false;
  const fullPath = join(cwd, dir);

  mkdirSync(fullPath, { recursive: true });

  const lockDir = lock ? join(fullPath, ".lock") : undefined;
  if (lockDir) mkdirSync(lockDir, { recursive: true });
  const fileAdapter = new FileStorageAdapter(fullPath, lockDir);
  const cachedAdapter = new CachedStorageAdapter(fileAdapter);

  Storage.configure(cachedAdapter);
  ensureGitignore(cwd, dir + "/");
}

declare module "./storage" {
  namespace Storage {
    function initialize(options?: InitializeOptions): void;
  }
}

(Storage as Record<string, unknown>).initialize = initialize;
