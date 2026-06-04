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
      CREATE TABLE message (id TEXT PRIMARY KEY);
    `);
    db.close();

    expect(() => createDb(dbPath)).toThrow();

    const checkDb = new Database(dbPath);
    try {
      expect(
        checkDb
          .query("SELECT name FROM _migrations WHERE name = ?")
          .get("0001_initial/migration.sql"),
      ).toBeNull();
    } finally {
      checkDb.close();
    }
  });

  test("creates communication state tables from ordered migrations", () => {
    dbPath = tempDbPath();

    const { sqlite } = createDb(dbPath);
    try {
      sqlite
        .query(
          `INSERT INTO pending_ask (
            id, data, status, origin_session_id, time_created, time_updated
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("ask-1", "{}", "open", "session-1", 1, 1);
      sqlite
        .query(
          `INSERT INTO worker_grant (
            id, worker_run_id, data, status, version, time_created, time_updated
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("grant-1", "run-1", "{}", "active", 1, 1, 1);

      expect(sqlite.query("SELECT id FROM pending_ask").get()).toEqual({ id: "ask-1" });
      expect(sqlite.query("SELECT id FROM worker_grant").get()).toEqual({ id: "grant-1" });
      const indexes = sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_ask'")
        .all() as Array<{ name: string }>;
      expect(indexes.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "idx_pending_ask_token_hash",
          "idx_pending_ask_external_conversation",
        ]),
      );
    } finally {
      sqlite.close();
    }
  });
});
