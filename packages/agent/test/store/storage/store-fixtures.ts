import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapStoreDatabase } from "../../../src/core/store/session-file";

export const policyFixture = {
  name: "allow-turn",
  kind: "turn",
  phase: "pre",
  match: { encodingVersion: 1, value: {} },
  verdict: { encodingVersion: 1, value: { kind: "allow" } },
  priority: 0,
  generation: 1,
} as const;

export function expectBusyBeforeSchema(schema: readonly string[]): void {
  const directory = mkdtempSync(join(tmpdir(), "ledger-busy-first-"));
  const path = join(directory, "notadb.sqlite");
  writeFileSync(path, "this file is deliberately not a sqlite database");
  const db = new Database(path);
  try {
    expect(() => bootstrapStoreDatabase(db, schema)).toThrow(
      expect.objectContaining({ code: "SQLITE_NOTADB", errno: 26 }),
    );
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  } finally {
    db.close();
    rmSync(directory, { recursive: true });
  }
}
