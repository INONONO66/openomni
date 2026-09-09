import { afterAll } from "bun:test";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ownedPaths = new Set<string>();
afterAll(() => {
  for (const path of ownedPaths) rmdirSync(dirname(path));
  ownedPaths.clear();
});

export function tempDbPath(label: string): string {
  const path = join(mkdtempSync(join(tmpdir(), `${label}-`)), "ledger.db");
  ownedPaths.add(path);
  return path;
}

export function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}
