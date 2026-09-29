import { rmSync } from "node:fs";

export function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}
