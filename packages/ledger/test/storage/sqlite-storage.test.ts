import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Message } from "@openomni/protocol";
import type { SessionInfo } from "../../src/session/info";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { removeSqliteFiles, tempDbPath } from "../helpers/sqlite";

type TextPart = Extract<Message.Part, { type: "text" }>;

function makeSession(id: string, timeCreated = Date.now()): SessionInfo {
  return {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test-model" },
    time: { created: timeCreated, updated: timeCreated },
    spawnDepth: 0,
  };
}

function makeUserMessage(sessionID: string, messageID: string, timeCreated?: number): Message.Info {
  return {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: timeCreated ?? Date.now() },
    agent: "test-agent",
    model: { providerID: "test", modelID: "test-model" },
  };
}

function makeTextPart(
  sessionID: string,
  messageID: string,
  partID: string,
  timeStart?: number,
): TextPart {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "text",
    text: `Part ${partID} content`,
    time: timeStart === undefined ? undefined : { start: timeStart },
  };
}

function findMessagesByStatus(
  adapter: SqliteStorageAdapter,
  status: string,
): Array<{ id: string; sessionId: string }> {
  const findByStatus = adapter.message.findByStatus;
  if (findByStatus === undefined) {
    throw new Error("SQLite message adapter must support status lookup");
  }
  return findByStatus(status);
}

function applyMigrationFixture(db: Database, name: string): void {
  const migrationPath = join(import.meta.dir, "../../migration", name);
  db.exec(readFileSync(migrationPath, "utf8"));
}

function makeToolPart(
  sessionID: string,
  messageID: string,
  partID: string,
  status: string,
  timeStart?: number,
): Message.Part {
  const base = {
    id: partID,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: `call-${partID}`,
    tool: "test-tool",
  };

  if (status === "pending") {
    return { ...base, state: { status: "pending", input: {} } };
  }

  if (status === "running") {
    return {
      ...base,
      state: { status: "running", input: {}, time: { start: timeStart ?? Date.now() } },
    };
  }

  if (status === "completed") {
    const start = timeStart ?? Date.now();
    return {
      ...base,
      state: {
        status: "completed",
        input: {},
        output: "ok",
        title: "done",
        metadata: {},
        time: { start, end: start + 1 },
      },
    };
  }

  if (status === "error") {
    const start = timeStart ?? Date.now();
    return {
      ...base,
      state: { status: "error", input: {}, error: "failed", time: { start, end: start + 1 } },
    };
  }

  throw new Error(`Unsupported tool status: ${status}`);
}

function storageDb(adapter: SqliteStorageAdapter): Database {
  return (adapter as unknown as { db: Database }).db;
}

function tableColumns(db: Database, table: string): string[] {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function indexNames(db: Database, table: string): string[] {
  return (db.query(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

describe("SqliteStorageAdapter", () => {
  let dbPath = "";
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = tempDbPath("test-sqlite");
    adapter = new SqliteStorageAdapter(dbPath);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch (_err) {
      void _err;
    }
    removeSqliteFiles(dbPath);
  });

  describe("PRAGMA verification", () => {
    test("journal_mode is WAL", () => {
      const db = new Database(dbPath);
      const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      db.close();
      expect(row.journal_mode).toBe("wal");
    });

    test("foreign_keys are enabled", () => {
      const row = (adapter as unknown as { db: Database }).db
        .query("PRAGMA foreign_keys")
        .get() as { foreign_keys: number };
      expect(row.foreign_keys).toBe(1);
    });
  });

  describe("migration", () => {
    test("all expected tables are created on fresh DB", () => {
      const db = new Database(dbPath);
      const tables = (
        db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      db.close();

      expect(tables).toContain("session");
      expect(tables).toContain("message");
      expect(tables).toContain("part");
      expect(tables).toContain("surface_key");
      expect(tables).toContain("artifact");
      expect(tables).toContain("bus_event");
      expect(tables).toContain("worker_run_state");
      expect(tables).toContain("_migrations");
      // #606: dead tables (zero readers/writers) dropped by migration 0017.
      for (const dead of [
        "event_log",
        "task",
        "task_run",
        "task_idempotency",
        "plan",
        "todo",
        "background_task",
      ]) {
        expect(tables).not.toContain(dead);
      }
    });

    test("observability tables expose the expected columns", () => {
      const db = storageDb(adapter);

      expect(tableColumns(db, "bus_event")).toEqual([
        "id",
        "session_id",
        "run_id",
        "event_type",
        "category",
        "data",
        "trace_id",
        "duration_ms",
        "time_created",
        "prev_hash",
        "event_hash",
        "visibility",
        "payload_status",
        "payload_diagnostic",
      ]);
      expect(tableColumns(db, "event_chain")).toEqual([
        "seq",
        "session_id",
        "event_type",
        "event_hash",
        "prev_hash",
        "time_created",
      ]);
      expect(tableColumns(db, "worker_run_state")).toEqual([
        "run_id",
        "session_id",
        "parent_session_id",
        "agent_name",
        "status",
        "title",
        "prompt",
        "resume_count",
        "assigned_step_id",
        "error",
        "time_created",
        "time_updated",
        "executor_kind",
      ]);
    });

    test("observability indexes are created", () => {
      const db = storageDb(adapter);

      expect(indexNames(db, "bus_event")).toEqual(
        expect.arrayContaining([
          "idx_bus_event_session_time",
          "idx_bus_event_run_time",
          "idx_bus_event_type_session",
          "idx_bus_event_category_session",
          "idx_bus_event_visibility_session",
          "idx_bus_event_trace",
          "idx_bus_event_hash",
        ]),
      );
      expect(indexNames(db, "event_chain")).toEqual(
        expect.arrayContaining(["idx_event_chain_session", "idx_event_chain_hash"]),
      );
      expect(indexNames(db, "worker_run_state")).toContain("idx_worker_run_state_session_time");
    });

    test("0005 migration backfills legacy worker run executor kind", () => {
      adapter.close();
      removeSqliteFiles(dbPath);

      const legacyDb = new Database(dbPath);
      applyMigrationFixture(legacyDb, "0001_initial/migration.sql");
      applyMigrationFixture(legacyDb, "0002_communication_state/migration.sql");
      applyMigrationFixture(legacyDb, "0003_communication_state_constraints/migration.sql");
      applyMigrationFixture(legacyDb, "0004_cron_job/migration.sql");
      legacyDb
        .query(
          `INSERT INTO session (id, data, time_created, time_updated)
           VALUES (?, ?, ?, ?)`,
        )
        .run("legacy-session", JSON.stringify(makeSession("legacy-session", 1)), 1, 1);
      legacyDb
        .query(
          `INSERT INTO worker_run_state (
             run_id, session_id, parent_session_id, agent_name, status, title, prompt,
             resume_count, assigned_step_id, error, time_created, time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "legacy-run",
          "legacy-session",
          null,
          "worker",
          "queued",
          "Legacy run",
          "do it",
          0,
          null,
          null,
          1,
          1,
        );
      expect(tableColumns(legacyDb, "worker_run_state")).not.toContain("executor_kind");
      legacyDb.close();

      const upgradedAdapter = new SqliteStorageAdapter(dbPath);
      const upgradedDb = storageDb(upgradedAdapter);

      expect(tableColumns(upgradedDb, "worker_run_state")).toContain("executor_kind");
      expect(
        upgradedDb
          .query("SELECT executor_kind FROM worker_run_state WHERE run_id = ?")
          .get("legacy-run"),
      ).toEqual({ executor_kind: "internal_chat_agent" });

      upgradedAdapter.close();
    });

    test("migrations are idempotent — second adapter open does not throw", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.close();

      const adapter2 = new SqliteStorageAdapter(dbPath);
      expect(adapter2.session.get("s1")).toBeDefined();
      adapter2.close();
    });

    test("failed migration does not leave partially applied schema behind", () => {
      adapter.close();
      removeSqliteFiles(dbPath);

      const db = new Database(dbPath);
      db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)");
      db.exec("CREATE TABLE message (id TEXT PRIMARY KEY)");
      db.close();

      expect(() => new SqliteStorageAdapter(dbPath)).toThrow();

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
  });

  describe("session", () => {
    test("get: returns undefined for non-existent", () => {
      expect(adapter.session.get("missing")).toBeUndefined();
    });

    test("get: returns session after set", () => {
      const session = makeSession("s1");
      adapter.session.set("s1", session);
      expect(adapter.session.get("s1")).toEqual(session);
    });

    test("get and list apply SessionInfo schema defaults to legacy rows", () => {
      const legacySession = {
        id: "legacy",
        title: "Legacy Session",
        model: { providerID: "test", modelID: "test-model" },
        time: { created: 100, updated: 100 },
      };

      storageDb(adapter)
        .query(
          `INSERT INTO session (id, data, time_created, time_updated)
           VALUES (?, ?, ?, ?)`,
        )
        .run("legacy", JSON.stringify(legacySession), 100, 100);

      const expected = { ...legacySession, spawnDepth: 0 };
      expect(adapter.session.get("legacy")).toEqual(expected);
      expect(adapter.session.list()).toEqual([expected]);
    });

    test("get rejects malformed legacy rows while applying SessionInfo defaults", () => {
      const malformedLegacySession = {
        title: "Malformed Legacy Session",
        model: { providerID: "test", modelID: "test-model" },
        time: { created: 100, updated: 100 },
      };

      storageDb(adapter)
        .query(
          `INSERT INTO session (id, data, time_created, time_updated)
           VALUES (?, ?, ?, ?)`,
        )
        .run("malformed-legacy", JSON.stringify(malformedLegacySession), 100, 100);

      expect(() => adapter.session.get("malformed-legacy")).toThrow();
    });

    test("set: upsert overwrites existing session", () => {
      const session = makeSession("s1");
      adapter.session.set("s1", session);

      const updated: SessionInfo = {
        ...session,
        title: "Updated Session",
        time: { ...session.time, updated: session.time.updated + 1 },
      };
      adapter.session.set("s1", updated);

      expect(adapter.session.get("s1")).toEqual(updated);
      expect(adapter.session.list()).toHaveLength(1);
    });

    test("list: returns empty array initially", () => {
      expect(adapter.session.list()).toEqual([]);
    });

    test("list: returns all sessions", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.session.set("s2", makeSession("s2"));

      const list = adapter.session.list();
      expect(list).toHaveLength(2);
      expect(list.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    });

    test("remove: returns true and deletes", () => {
      adapter.session.set("s1", makeSession("s1"));
      expect(adapter.session.remove("s1")).toBe(true);
      expect(adapter.session.get("s1")).toBeUndefined();
      expect(adapter.session.list()).toEqual([]);
    });

    test("remove: returns false for non-existent", () => {
      expect(adapter.session.remove("missing")).toBe(false);
    });
  });

  describe("message", () => {
    beforeEach(() => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.session.set("s2", makeSession("s2"));
    });

    test("get: returns undefined for non-existent", () => {
      expect(adapter.message.get("s1", "m1")).toBeUndefined();
    });

    test("get: returns message after set", () => {
      const message = makeUserMessage("s1", "m1");
      adapter.message.set("s1", message);
      expect(adapter.message.get("s1", "m1")).toEqual(message);
    });

    test("set: upsert overwrites existing message", () => {
      const initial = makeUserMessage("s1", "m1", 100);
      adapter.message.set("s1", initial);

      const updated = { ...initial, agent: "updated-agent" };
      adapter.message.set("s1", updated);

      expect(adapter.message.get("s1", "m1")).toEqual(updated);
      expect(adapter.message.list("s1")).toHaveLength(1);
    });

    test("list: returns empty array for unknown session", () => {
      expect(adapter.message.list("unknown")).toEqual([]);
    });

    test("list: returns messages sorted by time_created ASC, id ASC", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m2", 200));
      adapter.message.set("s1", makeUserMessage("s1", "m1", 100));
      adapter.message.set("s1", makeUserMessage("s1", "m3", 200));

      const list = adapter.message.list("s1");
      expect(list.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    });

    test("list: only returns messages for the given session", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m1", 1));
      adapter.message.set("s2", makeUserMessage("s2", "m2", 2));

      expect(adapter.message.list("s1").map((m) => m.id)).toEqual(["m1"]);
    });

    test("remove: returns true and deletes", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      expect(adapter.message.remove("s1", "m1")).toBe(true);
      expect(adapter.message.get("s1", "m1")).toBeUndefined();
      expect(adapter.message.list("s1")).toEqual([]);
    });

    test("remove: returns false for non-existent", () => {
      expect(adapter.message.remove("s1", "missing")).toBe(false);
    });

    test("list: sorts by time_created ascending, id as tiebreaker", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m-c", 300));
      adapter.message.set("s1", makeUserMessage("s1", "m-a", 100));
      adapter.message.set("s1", makeUserMessage("s1", "m-b", 100));
      adapter.message.set("s1", makeUserMessage("s1", "m-d", 200));

      const list = adapter.message.list("s1");
      expect(list.map((m) => m.id)).toEqual(["m-a", "m-b", "m-d", "m-c"]);
    });

    test("setStatus: updates status without touching message data", () => {
      const message = makeUserMessage("s1", "m1");
      adapter.message.set("s1", message);
      adapter.message.setStatus?.("m1", "processing");

      expect(adapter.message.get("s1", "m1")).toEqual(message);

      const found = findMessagesByStatus(adapter, "processing");
      expect(found).toHaveLength(1);
      expect(found[0]).toEqual({ id: "m1", sessionId: "s1" });
    });

    test("setStatus: upsert preserves status across message.set calls", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      adapter.message.setStatus?.("m1", "processing");
      adapter.message.set("s1", makeUserMessage("s1", "m1"));

      const found = findMessagesByStatus(adapter, "processing");
      expect(found.map((r) => r.id)).toContain("m1");
    });

    test("findByStatus: returns empty when none match", () => {
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      expect(findMessagesByStatus(adapter, "nonexistent")).toEqual([]);
    });
  });

  describe("part", () => {
    beforeEach(() => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      adapter.message.set("s1", makeUserMessage("s1", "m2"));
    });

    test("get: returns undefined for non-existent", () => {
      expect(adapter.part.get("m1", "p1")).toBeUndefined();
    });

    test("get: returns part after set", () => {
      const part = makeTextPart("s1", "m1", "p1", 100);
      adapter.part.set("m1", part);
      expect(adapter.part.get("m1", "p1")).toEqual(part);
    });

    test("set: upsert overwrites existing part", () => {
      const initial = makeTextPart("s1", "m1", "p1", 100);
      adapter.part.set("m1", initial);

      const updated: Message.Part = { ...initial, text: "updated" };
      adapter.part.set("m1", updated);

      expect(adapter.part.get("m1", "p1")).toEqual(updated);
      expect(adapter.part.list("m1")).toHaveLength(1);
    });

    test("list: returns empty array for unknown message", () => {
      expect(adapter.part.list("unknown")).toEqual([]);
    });

    test("list: returns parts in insertion order", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p4"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p2", 200));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p3", 200));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 100));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p0"));

      const list = adapter.part.list("m1");
      expect(list.map((p) => p.id)).toEqual(["p4", "p2", "p3", "p1", "p0"]);
    });

    test("list: only returns parts for the given message", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 100));
      adapter.part.set("m2", makeTextPart("s1", "m2", "p2", 100));

      expect(adapter.part.list("m1").map((p) => p.id)).toEqual(["p1"]);
    });

    test("remove: returns true and deletes", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 100));
      expect(adapter.part.remove("m1", "p1")).toBe(true);
      expect(adapter.part.get("m1", "p1")).toBeUndefined();
      expect(adapter.part.list("m1")).toEqual([]);
    });

    test("remove: returns false for non-existent", () => {
      expect(adapter.part.remove("m1", "missing")).toBe(false);
    });
  });

  describe("part sorting", () => {
    beforeEach(() => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
    });

    test("parts are returned in insertion order regardless of time_start", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "p-no-time"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p-with-time", 10));

      const list = adapter.part.list("m1");
      expect(list.map((p) => p.id)).toEqual(["p-no-time", "p-with-time"]);
    });

    test("tool parts are returned in insertion order", () => {
      adapter.part.set("m1", makeToolPart("s1", "m1", "tool-pending", "pending"));
      adapter.part.set("m1", makeToolPart("s1", "m1", "tool-running", "running", 300));
      adapter.part.set("m1", makeToolPart("s1", "m1", "tool-completed", "completed", 100));
      adapter.part.set("m1", makeToolPart("s1", "m1", "tool-error", "error", 200));

      const list = adapter.part.list("m1");
      expect(list.map((p) => p.id)).toEqual([
        "tool-pending",
        "tool-running",
        "tool-completed",
        "tool-error",
      ]);
    });

    test("parts of different types are returned in insertion order", () => {
      adapter.part.set("m1", makeTextPart("s1", "m1", "text-first"));
      adapter.part.set("m1", makeToolPart("s1", "m1", "tool-second", "pending"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "text-third"));

      const list = adapter.part.list("m1");
      expect(list.map((p) => p.id)).toEqual(["text-first", "tool-second", "text-third"]);
    });
  });

  describe("FK CASCADE", () => {
    test("deleting session cascades to messages and parts", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      adapter.message.set("s1", makeUserMessage("s1", "m2"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 100));
      adapter.part.set("m2", makeTextPart("s1", "m2", "p2", 100));

      adapter.session.remove("s1");

      expect(adapter.message.list("s1")).toEqual([]);
      expect(adapter.part.list("m1")).toEqual([]);
      expect(adapter.part.list("m2")).toEqual([]);
    });

    test("deleting message cascades to parts", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 100));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p2", 200));

      adapter.message.remove("s1", "m1");

      expect(adapter.part.list("m1")).toEqual([]);
    });

    test("deleting session does NOT cascade to surface_key (perimeter domain, #707)", () => {
      // Migration 0019 dropped the surface_key→session FK: the map is a
      // gateway-domain surface (docs/gateway-design.md §4) and a session-row
      // removal may not mutate it behind the gateway's back. The surviving
      // entry converges by brain-side re-materialization on the next Deliver.
      adapter.session.set("s1", makeSession("s1"));
      adapter.surfaceKey?.claim("channel:123", "s1");

      adapter.session.remove("s1");

      expect(adapter.surfaceKey?.lookup("channel:123")).toBe("s1");
    });

    test("deleting session cascades to artifact", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.artifact?.store("a1", "s1", "{}", "content");

      adapter.session.remove("s1");

      expect(adapter.artifact?.get("a1")).toBeUndefined();
    });

    test("deleting session cascades to observability tables", () => {
      adapter.session.set("s1", makeSession("s1"));
      const db = storageDb(adapter);

      db.query(
        `INSERT INTO bus_event
         (session_id, run_id, event_type, category, data, trace_id, duration_ms, time_created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("s1", "run-1", "worker.run.started", "worker", "{}", "trace-1", 10, 100);
      db.query(
        `INSERT INTO worker_run_state
         (run_id, session_id, parent_session_id, agent_name, status, title, prompt, resume_count, assigned_step_id, error, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("run-1", "s1", null, "worker", "running", "title", "prompt", 0, null, null, 100, 100);

      adapter.session.remove("s1");

      expect(db.query("SELECT COUNT(*) AS count FROM bus_event").get()).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM worker_run_state").get()).toEqual({
        count: 0,
      });
    });
  });

  describe("surfaceKey", () => {
    beforeEach(() => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.session.set("s2", makeSession("s2"));
    });

    test("lookup: returns undefined for unregistered key", () => {
      expect(adapter.surfaceKey?.lookup("channel:999")).toBeUndefined();
    });

    test("claim and lookup", () => {
      adapter.surfaceKey?.claim("channel:123", "s1");
      expect(adapter.surfaceKey?.lookup("channel:123")).toBe("s1");
    });

    test("claim with the current owner as expected reassigns the mapping", () => {
      adapter.surfaceKey?.claim("channel:123", "s1");
      adapter.surfaceKey?.claim("channel:123", "s2", "s1");
      expect(adapter.surfaceKey?.lookup("channel:123")).toBe("s2");
    });
  });

  describe("artifact", () => {
    beforeEach(() => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.session.set("s2", makeSession("s2"));
    });

    test("get: returns undefined for non-existent", () => {
      expect(adapter.artifact?.get("missing")).toBeUndefined();
    });

    test("store and get", () => {
      adapter.artifact?.store("a1", "s1", '{"type":"file"}', "file content");
      const result = adapter.artifact?.get("a1");
      expect(result).toEqual({
        meta: '{"type":"file"}',
        content: "file content",
        sessionId: "s1",
      });
    });

    test("store: upsert updates existing artifact", () => {
      adapter.artifact?.store("a1", "s1", "{}", "old content");
      adapter.artifact?.store("a1", "s1", "{}", "new content");
      expect(adapter.artifact?.get("a1")?.content).toBe("new content");
    });
  });

  describe("clear", () => {
    test("clears all data from all tables", () => {
      adapter.session.set("s1", makeSession("s1"));
      adapter.message.set("s1", makeUserMessage("s1", "m1"));
      adapter.part.set("m1", makeTextPart("s1", "m1", "p1", 10));
      adapter.surfaceKey?.claim("channel:1", "s1");
      adapter.artifact?.store("a1", "s1", "{}", "content");
      adapter.clear();

      expect(adapter.session.list()).toEqual([]);
      expect(adapter.message.list("s1")).toEqual([]);
      expect(adapter.part.list("m1")).toEqual([]);
      expect(adapter.surfaceKey?.lookup("channel:1")).toBeUndefined();
      expect(adapter.artifact?.get("a1")).toBeUndefined();
    });
  });

  describe("close", () => {
    test("close() does not throw", () => {
      expect(() => adapter.close()).not.toThrow();
    });

    test("operations after close throw", () => {
      adapter.close();
      expect(() => adapter.session.list()).toThrow();
    });
  });

  describe("persistence", () => {
    test("data survives close and reopen", () => {
      const session = makeSession("s1");
      adapter.session.set("s1", session);
      adapter.close();

      const adapter2 = new SqliteStorageAdapter(dbPath);
      expect(adapter2.session.get("s1")).toEqual(session);
      adapter2.close();
    });
  });
});
