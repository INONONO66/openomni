import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FINAL_APPLICATION_TABLES,
  initializeSqliteDatabase,
} from "../../src/storage/sqlite-schema-lifecycle";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("P2 clean final schema manifest", () => {
  test("contains exactly the 25 strict application tables and no legacy table", () => {
    const root = mkdtempSync(join(tmpdir(), "openomni-final-schema-"));
    roots.push(root);
    const db = new Database(join(root, "ledger.sqlite"), { strict: true });
    initializeSqliteDatabase(db);

    const tables = db
      .query(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => (row as { readonly name: string }).name);
    expect(tables).toEqual([...FINAL_APPLICATION_TABLES].sort());
    expect(tables).toHaveLength(25);

    const strictness = db.query("PRAGMA table_list").all() as {
      readonly name: string;
      readonly strict: number;
    }[];
    for (const table of FINAL_APPLICATION_TABLES) {
      expect(strictness.find((row) => row.name === table)?.strict).toBe(1);
    }

    const legacyNames = [
      "session",
      "message",
      "part",
      "surface_key",
      "artifact",
      "work_item",
      "worker_run_state",
      "pending_ask",
      "pending_interaction",
      "bus_event",
    ];
    expect(tables.filter((name) => legacyNames.includes(name))).toEqual([]);
    db.close();
  });

  test("freezes the baseline marker and immutable artifact bytes shape", () => {
    const db = new Database(":memory:", { strict: true });
    initializeSqliteDatabase(db);

    expect(db.query("SELECT name FROM _migrations").get()).toEqual({
      name: "0001_p2_clean_baseline/migration.sql",
    });
    expect(db.query("SELECT baseline_id, schema_version FROM schema_meta").get()).toEqual({
      baseline_id: "p2-clean-v1",
      schema_version: 1,
    });

    const columns = db.query("PRAGMA table_info(artifact_blob)").all() as {
      readonly name: string;
      readonly type: string;
      readonly notnull: number;
    }[];
    expect(columns.map(({ name, type, notnull }) => ({ name, type, notnull }))).toEqual([
      { name: "content_hash", type: "TEXT", notnull: 1 },
      { name: "byte_length", type: "INTEGER", notnull: 1 },
      { name: "bytes", type: "BLOB", notnull: 1 },
      { name: "created_at_db_ms", type: "INTEGER", notnull: 1 },
    ]);
    db.close();
  });
});
