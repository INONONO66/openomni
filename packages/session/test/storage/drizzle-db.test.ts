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
          `INSERT INTO session (id, data, time_created, time_updated)
           VALUES (?, ?, ?, ?)`,
        )
        .run("session-1", "{}", 1, 1);
      sqlite
        .query(
          `INSERT INTO worker_run_state (
            run_id, session_id, agent_name, status, title, prompt, time_created, time_updated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("run-1", "session-1", "worker", "queued", "title", "prompt", 1, 1);
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
      sqlite.query("DELETE FROM session WHERE id = ?").run("session-1");
      expect(sqlite.query("SELECT id FROM pending_ask").get()).toBeNull();
      expect(sqlite.query("SELECT id FROM worker_grant").get()).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  test("upgrades old communication tables with FK constraints", () => {
    dbPath = tempDbPath();

    const { sqlite } = createDb(dbPath);
    try {
      sqlite.exec(`
        DROP TABLE worker_grant;
        DROP TABLE pending_ask;

        CREATE TABLE pending_ask (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          status TEXT NOT NULL,
          origin_session_id TEXT NOT NULL,
          endpoint_id TEXT,
          channel_id TEXT,
          external_message_id TEXT,
          reply_to_message_id TEXT,
          thread_id TEXT,
          token_hash TEXT,
          external_conversation_id TEXT,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL
        );

        CREATE TABLE worker_grant (
          id TEXT PRIMARY KEY,
          worker_run_id TEXT NOT NULL,
          data TEXT NOT NULL,
          status TEXT NOT NULL,
          version INTEGER NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER NOT NULL,
          expires_at INTEGER
        );

        DELETE FROM _migrations
        WHERE name = '0003_communication_state_constraints/migration.sql';
      `);
      sqlite
        .query(
          `INSERT INTO session (id, data, time_created, time_updated)
           VALUES (?, ?, ?, ?)`,
        )
        .run("session-upgrade", "{}", 1, 1);
      sqlite
        .query(
          `INSERT INTO worker_run_state (
            run_id, session_id, agent_name, status, title, prompt, time_created, time_updated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("run-upgrade", "session-upgrade", "worker", "queued", "title", "prompt", 1, 1);
      sqlite
        .query(
          `INSERT INTO pending_ask (
            id, data, status, origin_session_id, time_created, time_updated
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("ask-valid", "{}", "open", "session-upgrade", 1, 1);
      sqlite
        .query(
          `INSERT INTO pending_ask (
            id, data, status, origin_session_id, time_created, time_updated
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("ask-orphan", "{}", "open", "missing-session", 1, 1);
      sqlite
        .query(
          `INSERT INTO worker_grant (
            id, worker_run_id, data, status, version, time_created, time_updated
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("grant-valid", "run-upgrade", "{}", "active", 1, 1, 1);
      sqlite
        .query(
          `INSERT INTO worker_grant (
            id, worker_run_id, data, status, version, time_created, time_updated
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("grant-orphan", "missing-run", "{}", "active", 1, 1, 1);
    } finally {
      sqlite.close();
    }

    const upgraded = createDb(dbPath);
    try {
      expect(upgraded.sqlite.query("SELECT id FROM pending_ask ORDER BY id").all()).toEqual([
        { id: "ask-valid" },
      ]);
      expect(upgraded.sqlite.query("SELECT id FROM worker_grant ORDER BY id").all()).toEqual([
        { id: "grant-valid" },
      ]);
      expect(() =>
        upgraded.sqlite
          .query(
            `INSERT INTO pending_ask (
              id, data, status, origin_session_id, time_created, time_updated
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run("ask-new-orphan", "{}", "open", "missing-session", 1, 1),
      ).toThrow();
      expect(() =>
        upgraded.sqlite
          .query(
            `INSERT INTO worker_grant (
              id, worker_run_id, data, status, version, time_created, time_updated
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("grant-new-orphan", "missing-run", "{}", "active", 1, 1, 1),
      ).toThrow();
    } finally {
      upgraded.sqlite.close();
    }
  });
});
