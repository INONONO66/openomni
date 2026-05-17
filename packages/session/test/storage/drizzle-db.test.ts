import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createDb } from "../../src/storage/drizzle/db";

function tempDbPath(): string {
  return join(tmpdir(), `test-drizzle-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function removeSqliteFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch (_err) {
      void _err;
    }
  }
}

describe("drizzle createDb migrations", () => {
  let dbPath = "";

  afterEach(() => {
    removeSqliteFiles(dbPath);
  });

  test("failed migration rolls back DDL and migration marker", () => {
    dbPath = tempDbPath();

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE _migrations (name TEXT PRIMARY KEY);
      INSERT INTO _migrations (name) VALUES ('0001_initial/migration.sql');
      INSERT INTO _migrations (name) VALUES ('0002_pragma_fk_indices/migration.sql');
      INSERT INTO _migrations (name) VALUES ('0003_new_tables/migration.sql');
      CREATE TABLE message (id TEXT PRIMARY KEY);
    `);
    db.close();

    expect(() => createDb(dbPath)).toThrow();

    const checkDb = new Database(dbPath);
    try {
      const columns = checkDb.query("PRAGMA table_info(message)").all() as Array<{ name: string }>;
      expect(columns.map((row) => row.name)).not.toContain("status");
      expect(
        checkDb
          .query("SELECT name FROM _migrations WHERE name = ?")
          .get("0004_message_status/migration.sql"),
      ).toBeNull();
    } finally {
      checkDb.close();
    }
  });
});
