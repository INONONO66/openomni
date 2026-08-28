import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLedgerArchiveManifest,
  writeArchiveManifestAtomically,
} from "./generate-ledger-archive-manifest";

function fixture(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE _migrations (name TEXT NOT NULL)");
  db.run("INSERT INTO _migrations VALUES ('0022_bus_event_payload_status/migration.sql')");
  db.run("CREATE TABLE worker_run_state (run_id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  return db;
}

describe("ledger archive manifest", () => {
  test("atomically replaces the manifest and retains the previous file if replacement fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openomni-archive-manifest-"));
    const outPath = join(directory, "ledger-archive-manifest.json");
    try {
      await writeFile(outPath, "previous\n");
      await writeArchiveManifestAtomically(outPath, "replacement\n");
      expect(await readFile(outPath, "utf8")).toBe("replacement\n");
      expect(await readdir(directory)).toEqual(["ledger-archive-manifest.json"]);

      await expect(
        writeArchiveManifestAtomically(outPath, "partial\n", async () => {
          throw new Error("injected replacement failure");
        }),
      ).rejects.toThrow("injected replacement failure");
      expect(await readFile(outPath, "utf8")).toBe("replacement\n");
      expect(await readdir(directory)).toEqual(["ledger-archive-manifest.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([["worker_run_state", "run_id"]] as const)("%s uses canonical id order, schema/range identity, deterministic sha256, and detects tampering", (table, idColumn) => {
    const db = fixture();
    try {
      const insert = db.query(`INSERT INTO ${table} (${idColumn}, status) VALUES (?, ?)`);
      insert.run("item-b", "open");
      insert.run("item-c", "resolved");
      insert.run("item-a", "cancelled");

      const first = buildLedgerArchiveManifest(db).tables.find((entry) => entry.table === table);
      if (!first) throw new Error(`manifest misses ${table}`);
      expect(first).toMatchObject({
        sourceSchemaVersion: "0022_bus_event_payload_status/migration.sql",
        rowCount: 3,
        idRange: { first: "item-a", last: "item-c" },
      });
      expect(first.integrityHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(
        buildLedgerArchiveManifest(db).tables.find((entry) => entry.table === table)?.integrityHash,
      ).toBe(first.integrityHash);

      db.query(`UPDATE ${table} SET status = 'tampered' WHERE ${idColumn} = 'item-b'`).run();
      const tampered = buildLedgerArchiveManifest(db).tables.find((entry) => entry.table === table);
      expect(tampered?.integrityHash).not.toBe(first.integrityHash);
      expect(tampered?.rowCount).toBe(3);
    } finally {
      db.close();
    }
  });
});
