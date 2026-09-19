import { beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../src";
import "../../src/storage/initialize";

/** Reset and reinitialize the shared in-memory SQLite storage around each test. */
export function useMemoryStorage() {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });
  afterEach(() => {
    Storage.reset();
  });
}

/** Own one real SQLite connection and its directory for each test. */
export function useSqliteStorage(label: string) {
  let directory = "";
  let path = "";
  beforeEach(() => {
    Storage.reset();
    directory = mkdtempSync(join(tmpdir(), `${label}-`));
    path = join(directory, "ledger.db");
    Storage.initialize({ dbPath: path });
  });
  afterEach(() => {
    Storage.reset();
    rmSync(directory, { recursive: true });
  });
  return {
    get path() {
      return path;
    },
    reopen() {
      Storage.reset();
      Storage.initialize({ dbPath: path });
    },
  };
}
