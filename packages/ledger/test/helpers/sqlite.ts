import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tempDbPath(label: string): string {
  return join(tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

export function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
}
