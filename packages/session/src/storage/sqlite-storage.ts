import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, Task, Todo, Storage as ProtocolStorage } from "@openomni/protocol";
import { getPartStartTime } from "./part-time";
import type { SessionInfo } from "../session/info";
import type { Storage } from "./storage";

const MIGRATION_DIR = join(import.meta.dir, "../../migration");

const ORDERED_MIGRATIONS = [
  "0001_initial/migration.sql",
  "0002_pragma_fk_indices/migration.sql",
  "0003_new_tables/migration.sql",
  "0004_message_status/migration.sql",
  "0005_background_task/migration.sql",
  "0006_task_plan_todo/migration.sql",
  "0007_todo_fk_idempotency_idx/migration.sql",
];

function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA cache_size = -64000");
  db.exec("PRAGMA mmap_size = 268435456");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
}

function applyMigrations(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");

  for (const name of ORDERED_MIGRATIONS) {
    const applied = db.query("SELECT 1 FROM _migrations WHERE name = ?").get(name);
    if (applied) continue;

    // 0004 compat: if status column already exists (from an older migration path), skip DDL
    if (name === "0004_message_status/migration.sql" && hasMessageStatusColumn(db)) {
      db.exec(`INSERT OR IGNORE INTO _migrations (name) VALUES ('${name}')`);
      continue;
    }

    const sql = readFileSync(join(MIGRATION_DIR, name), "utf-8");
    db.exec(sql);
    db.exec(`INSERT INTO _migrations (name) VALUES ('${name}')`);
  }
}

function hasMessageStatusColumn(db: Database): boolean {
  const rows = db.query("PRAGMA table_info(message)").all() as Array<{ name: string }>;
  return rows.some((r) => r.name === "status");
}

export class SqliteStorageAdapter implements Storage.Adapter {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    applyPragmas(this.db);
    applyMigrations(this.db);
  }

  session = {
    get: (id: string): SessionInfo | undefined => {
      const row = this.db.query("SELECT data FROM session WHERE id = ?").get(id) as {
        data: string;
      } | null;
      return row ? (JSON.parse(row.data) as SessionInfo) : undefined;
    },

    set: (id: string, info: SessionInfo): void => {
      this.db
        .query(
          `INSERT INTO session (id, data, time_created, time_updated)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             time_created = excluded.time_created,
             time_updated = excluded.time_updated`,
        )
        .run(id, JSON.stringify(info), info.time.created, info.time.updated);
    },

    list: (): SessionInfo[] => {
      const rows = this.db.query("SELECT data FROM session").all() as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as SessionInfo);
    },

    remove: (id: string): boolean => {
      const result = this.db.query("DELETE FROM session WHERE id = ?").run(id);
      this.eventSequenceBySession.delete(id);
      return result.changes > 0;
    },
  };

  message = {
    get: (sessionID: string, messageID: string): Message.Info | undefined => {
      const row = this.db
        .query("SELECT data FROM message WHERE id = ? AND session_id = ?")
        .get(messageID, sessionID) as { data: string } | null;
      return row ? (JSON.parse(row.data) as Message.Info) : undefined;
    },

    set: (sessionID: string, message: Message.Info): void => {
      // status is intentionally omitted from the UPDATE set — preserved across upserts
      this.db
        .query(
          `INSERT INTO message (id, session_id, data, role, time_created)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             session_id = excluded.session_id,
             data = excluded.data,
             role = excluded.role,
             time_created = excluded.time_created`,
        )
        .run(
          message.id,
          sessionID,
          JSON.stringify(message),
          message.role ?? null,
          message.time.created,
        );
    },

    list: (sessionID: string): Message.Info[] => {
      const rows = this.db
        .query("SELECT data FROM message WHERE session_id = ? ORDER BY time_created ASC, rowid ASC")
        .all(sessionID) as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as Message.Info);
    },

    listPage: (
      sessionID: string,
      options: { limit: number; before?: string },
    ): Storage.MessagePage => {
      const cursor = options.before ? decodeCursor(options.before) : undefined;

      type Row = { id: string; time_created: number; data: string };
      let rows: Row[];

      if (cursor) {
        rows = this.db
          .query(
            `SELECT id, time_created, data FROM message
             WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))
             ORDER BY time_created DESC, id DESC
             LIMIT ?`,
          )
          .all(sessionID, cursor.time, cursor.time, cursor.id, options.limit + 1) as Row[];
      } else {
        rows = this.db
          .query(
            `SELECT id, time_created, data FROM message
             WHERE session_id = ?
             ORDER BY time_created DESC, id DESC
             LIMIT ?`,
          )
          .all(sessionID, options.limit + 1) as Row[];
      }

      const more = rows.length > options.limit;
      const page = more ? rows.slice(0, options.limit) : rows;
      const items = page.map((r) => JSON.parse(r.data) as Message.Info).reverse();
      const tail = page.at(-1);

      return {
        items,
        more,
        nextCursor: more && tail ? encodeCursor(tail.id, tail.time_created) : null,
      };
    },

    remove: (sessionID: string, messageID: string): boolean => {
      const result = this.db
        .query("DELETE FROM message WHERE id = ? AND session_id = ?")
        .run(messageID, sessionID);
      return result.changes > 0;
    },

    setStatus: (messageID: string, status: string): void => {
      this.db.query("UPDATE message SET status = ? WHERE id = ?").run(status, messageID);
    },

    findByStatus: (status: string): Array<{ id: string; sessionId: string }> => {
      const rows = this.db
        .query("SELECT id, session_id FROM message WHERE status = ?")
        .all(status) as Array<{ id: string; session_id: string }>;
      return rows.map((r) => ({ id: r.id, sessionId: r.session_id }));
    },
  };

  part = {
    get: (messageID: string, partID: string): Message.Part | undefined => {
      const row = this.db
        .query("SELECT data FROM part WHERE id = ? AND message_id = ?")
        .get(partID, messageID) as { data: string } | null;
      return row ? (JSON.parse(row.data) as Message.Part) : undefined;
    },

    set: (messageID: string, part: Message.Part): void => {
      const timeStart = getPartStartTime(part) ?? null;
      this.db
        .query(
          `INSERT INTO part (id, message_id, data, type, time_start)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             message_id = excluded.message_id,
             data = excluded.data,
             type = excluded.type,
             time_start = excluded.time_start`,
        )
        .run(part.id, messageID, JSON.stringify(part), part.type ?? null, timeStart);
    },

    list: (messageID: string): Message.Part[] => {
      const rows = this.db
        .query("SELECT data FROM part WHERE message_id = ? ORDER BY rowid ASC")
        .all(messageID) as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as Message.Part);
    },

    listByMessageIDs: (messageIDs: string[]): Message.Part[] => {
      if (messageIDs.length === 0) return [];
      const placeholders = messageIDs.map(() => "?").join(", ");
      // dynamic IN — can't cache this prepared statement
      const rows = this.db
        .prepare(`SELECT data FROM part WHERE message_id IN (${placeholders}) ORDER BY rowid ASC`)
        .all(...messageIDs) as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as Message.Part);
    },

    remove: (messageID: string, partID: string): boolean => {
      const result = this.db
        .query("DELETE FROM part WHERE id = ? AND message_id = ?")
        .run(partID, messageID);
      return result.changes > 0;
    },
  };

  surfaceKey = {
    register: (key: string, sessionId: string): void => {
      this.db
        .query(
          `INSERT INTO surface_key (key, session_id, time_created)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             session_id = excluded.session_id,
             time_created = excluded.time_created`,
        )
        .run(key, sessionId, Date.now());
    },

    lookup: (key: string): string | undefined => {
      const row = this.db.query("SELECT session_id FROM surface_key WHERE key = ?").get(key) as {
        session_id: string;
      } | null;
      return row?.session_id;
    },

    delete: (key: string): void => {
      this.db.query("DELETE FROM surface_key WHERE key = ?").run(key);
    },

    listBySession: (sessionId: string): string[] => {
      const rows = this.db
        .query("SELECT key FROM surface_key WHERE session_id = ?")
        .all(sessionId) as Array<{ key: string }>;
      return rows.map((r) => r.key);
    },
  };

  artifact = {
    store: (id: string, sessionId: string, meta: string, content: string): void => {
      const now = Date.now();
      this.db
        .query(
          `INSERT INTO artifact (id, session_id, meta, content, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             session_id = excluded.session_id,
             meta = excluded.meta,
             content = excluded.content,
             time_updated = excluded.time_updated`,
        )
        .run(id, sessionId, meta, content, now, now);
    },

    get: (id: string): { meta: string; content: string; sessionId: string } | undefined => {
      const row = this.db
        .query("SELECT meta, content, session_id FROM artifact WHERE id = ?")
        .get(id) as { meta: string; content: string; session_id: string } | null;
      if (!row) return undefined;
      return { meta: row.meta, content: row.content, sessionId: row.session_id };
    },

    list: (sessionId: string): Array<{ id: string; meta: string; content: string }> => {
      return this.db
        .query("SELECT id, meta, content FROM artifact WHERE session_id = ?")
        .all(sessionId) as Array<{ id: string; meta: string; content: string }>;
    },

    delete: (id: string): void => {
      this.db.query("DELETE FROM artifact WHERE id = ?").run(id);
    },
  };

  // session-scoped sequence cursor; primed on first lookup from the durable
  // log and advanced in lock-step with allocateSequence so multiple writers
  // (ingress projection, session.addMessage) share one monotonic counter
  // without re-reading every row on each append. bounded with LRU eviction
  // so a long-lived adapter does not retain entries for stale sessions.
  private eventSequenceBySession = new Map<string, number>();

  private static readonly MAX_SEQUENCE_CACHE_ENTRIES = 10_000;

  private primeEventSequence(sessionId: string): number {
    const row = this.db
      .query(
        `SELECT MAX(CAST(json_extract(data, '$.sequence') AS INTEGER)) AS max_sequence
         FROM event_log WHERE session_id = ?`,
      )
      .get(sessionId) as { max_sequence: number | null } | undefined;
    return row?.max_sequence ?? 0;
  }

  private touchSequenceCache(sessionId: string, value: number): void {
    // Map iteration order is insertion order; deleting before set keeps the
    // touched session at the tail so the head is always the LRU candidate.
    this.eventSequenceBySession.delete(sessionId);
    this.eventSequenceBySession.set(sessionId, value);
    if (this.eventSequenceBySession.size > SqliteStorageAdapter.MAX_SEQUENCE_CACHE_ENTRIES) {
      const oldest = this.eventSequenceBySession.keys().next().value;
      if (oldest !== undefined) this.eventSequenceBySession.delete(oldest);
    }
  }

  eventLog = {
    append: (sessionId: string, type: string, data: string): number => {
      const result = this.db
        .query("INSERT INTO event_log (session_id, type, data, time_created) VALUES (?, ?, ?, ?)")
        .run(sessionId, type, data, Date.now());
      return Number(result.lastInsertRowid);
    },

    replay: (
      sessionId: string,
    ): Array<{ id: number; type: string; status: string; data: string }> => {
      return this.db
        .query("SELECT id, type, status, data FROM event_log WHERE session_id = ? ORDER BY id ASC")
        .all(sessionId) as Array<{ id: number; type: string; status: string; data: string }>;
    },

    listIncomplete: (sessionId: string): Array<{ id: number; type: string; data: string }> => {
      return this.db
        .query(
          `SELECT id, type, data FROM event_log
           WHERE session_id = ? AND status != 'completed'
           ORDER BY id ASC`,
        )
        .all(sessionId) as Array<{ id: number; type: string; data: string }>;
    },

    markComplete: (_sessionId: string, eventId: number): void => {
      this.db.query("UPDATE event_log SET status = 'completed' WHERE id = ?").run(eventId);
    },

    listIncompleteSessions: (): string[] => {
      const rows = this.db
        .query("SELECT DISTINCT session_id FROM event_log WHERE status != 'completed'")
        .all() as Array<{ session_id: string }>;
      return rows.map((r) => r.session_id);
    },

    allocateSequence: (sessionId: string): number => {
      let current = this.eventSequenceBySession.get(sessionId);
      if (current === undefined) {
        current = this.primeEventSequence(sessionId);
      }
      const next = current + 1;
      this.touchSequenceCache(sessionId, next);
      return next;
    },
  };

  backgroundTask = {
    upsert: (
      id: string,
      status: string,
      parentSessionId: string,
      data: string,
      output?: string,
    ): void => {
      const now = Date.now();
      this.db
        .query(
          `INSERT INTO background_task (id, status, parent_session_id, data, output, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             data = excluded.data,
             output = COALESCE(excluded.output, background_task.output),
             time_updated = excluded.time_updated`,
        )
        .run(id, status, parentSessionId, data, output ?? null, now, now);
    },

    get: (id: string): { data: string; status: string; output?: string } | undefined => {
      const row = this.db
        .query("SELECT data, status, output FROM background_task WHERE id = ?")
        .get(id) as { data: string; status: string; output: string | null } | null;
      if (!row) return undefined;
      return { data: row.data, status: row.status, output: row.output ?? undefined };
    },

    listByStatus: (
      ...statuses: string[]
    ): Array<{ id: string; data: string; status: string; output?: string }> => {
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT id, data, status, output FROM background_task WHERE status IN (${placeholders})`,
        )
        .all(...statuses) as Array<{
        id: string;
        data: string;
        status: string;
        output: string | null;
      }>;
      return rows.map((r) => ({
        id: r.id,
        data: r.data,
        status: r.status,
        output: r.output ?? undefined,
      }));
    },

    delete: (id: string): void => {
      this.db.query("DELETE FROM background_task WHERE id = ?").run(id);
    },
  };

  task: ProtocolStorage.TaskSubAdapter = {
    task: {
      get: (id: string): Task.Info | undefined => {
        const row = this.db.query("SELECT data FROM task WHERE id = ?").get(id) as {
          data: string;
        } | null;
        return row ? (JSON.parse(row.data) as Task.Info) : undefined;
      },

      set: (id: string, info: Task.Info): void => {
        const now = Date.now();
        this.db
          .query(
            `INSERT INTO task (id, owner_type, owner_id, status, data, time_created, time_updated)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               owner_type = excluded.owner_type,
               owner_id = excluded.owner_id,
               status = excluded.status,
               data = excluded.data,
               time_updated = excluded.time_updated`,
          )
          .run(id, info.owner.type, info.owner.id, info.status, JSON.stringify(info), now, now);
      },

      list: (filter?: ProtocolStorage.TaskListFilter): Task.Info[] => {
        let tasks = (this.db.query("SELECT data FROM task").all() as Array<{ data: string }>).map(
          (r) => JSON.parse(r.data) as Task.Info,
        );

        if (!filter) return tasks;

        if (filter.status) {
          const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
          tasks = tasks.filter((t) => statuses.includes(t.status));
        }
        if (filter.ownerId) {
          tasks = tasks.filter((t) => t.owner.id === filter.ownerId);
        }
        if (filter.assignedAgentId) {
          tasks = tasks.filter((t) => t.assignedAgentId === filter.assignedAgentId);
        }
        if (filter.tags && filter.tags.length > 0) {
          tasks = tasks.filter((t) => filter.tags?.every((tag) => t.tags?.includes(tag)));
        }

        return tasks;
      },

      remove: (id: string): boolean => {
        const existing = this.db.query("SELECT 1 FROM task WHERE id = ?").get(id);
        if (!existing) return false;
        // CASCADE in migration auto-removes task_run rows and their task_idempotency entries
        this.db.query("DELETE FROM task WHERE id = ?").run(id);
        return true;
      },
    },

    run: {
      get: (runId: string): Task.Run | undefined => {
        const row = this.db.query("SELECT data FROM task_run WHERE id = ?").get(runId) as {
          data: string;
        } | null;
        return row ? (JSON.parse(row.data) as Task.Run) : undefined;
      },

      set: (taskId: string, run: Task.Run): void => {
        const now = Date.now();
        this.db.transaction(() => {
          this.db
            .query(
              `INSERT INTO task_run (id, task_id, status, trigger_data, data, time_created, time_updated)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 status = excluded.status,
                 trigger_data = excluded.trigger_data,
                 data = excluded.data,
                 time_updated = excluded.time_updated`,
            )
            .run(
              run.runId,
              taskId,
              run.status,
              JSON.stringify(run.trigger),
              JSON.stringify(run),
              now,
              now,
            );
          this.db
            .query(
              `INSERT INTO task_idempotency (key, run_id, time_created)
               VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET run_id = excluded.run_id`,
            )
            .run(run.idempotencyKey, run.runId, now);
        })();
      },

      list: (taskId: string, opts?: ProtocolStorage.RunListOptions): Task.Run[] => {
        let runs = (
          this.db.query("SELECT data FROM task_run WHERE task_id = ?").all(taskId) as Array<{
            data: string;
          }>
        ).map((r) => JSON.parse(r.data) as Task.Run);

        if (opts?.sortBy) {
          const { sortBy } = opts;
          const dir = opts.sortOrder === "asc" ? 1 : -1;
          runs.sort((a, b) => dir * ((a[sortBy] ?? 0) - (b[sortBy] ?? 0)));
        }
        if (opts?.offset !== undefined || opts?.limit !== undefined) {
          const start = opts.offset ?? 0;
          runs = runs.slice(start, start + (opts.limit ?? runs.length));
        }

        return runs;
      },

      listByStatus: (statuses: Task.RunStatus[]): Task.Run[] => {
        if (statuses.length === 0) return [];
        const placeholders = statuses.map(() => "?").join(", ");
        const rows = this.db
          .prepare(`SELECT data FROM task_run WHERE status IN (${placeholders})`)
          .all(...statuses) as Array<{ data: string }>;
        return rows.map((r) => JSON.parse(r.data) as Task.Run);
      },

      remove: (runId: string): boolean => {
        const existing = this.db.query("SELECT 1 FROM task_run WHERE id = ?").get(runId);
        if (!existing) return false;
        // CASCADE auto-removes task_idempotency entry
        this.db.query("DELETE FROM task_run WHERE id = ?").run(runId);
        return true;
      },

      getByIdempotencyKey: (key: string): Task.Run | undefined => {
        const row = this.db.query("SELECT run_id FROM task_idempotency WHERE key = ?").get(key) as {
          run_id: string;
        } | null;
        if (!row) return undefined;
        return this.task.run.get(row.run_id);
      },
    },
  };

  todo: ProtocolStorage.TodoSubAdapter = {
    upsertAll: async (sessionId: string, todos: Todo.Info[]): Promise<void> => {
      this.db.transaction(() => {
        this.db.query("DELETE FROM todo WHERE session_id = ?").run(sessionId);
        for (const todo of todos) {
          const now = Date.now();
          this.db
            .query(
              `INSERT INTO todo (id, session_id, content, status, priority, position, time_created, time_updated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              todo.id,
              sessionId,
              todo.content,
              todo.status,
              todo.priority,
              todo.position,
              now,
              now,
            );
        }
      })();
    },

    list: async (sessionId: string): Promise<Todo.Info[]> => {
      const rows = this.db
        .query(
          "SELECT id, session_id, content, status, priority, position FROM todo WHERE session_id = ? ORDER BY position ASC",
        )
        .all(sessionId) as Array<{
        id: string;
        session_id: string;
        content: string;
        status: string;
        priority: string;
        position: number;
      }>;
      return rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        content: r.content,
        status: r.status as Todo.Status,
        priority: r.priority as Todo.Priority,
        position: r.position,
      }));
    },

    deleteAll: async (sessionId: string): Promise<void> => {
      this.db.query("DELETE FROM todo WHERE session_id = ?").run(sessionId);
    },
  };

  clear(): void {
    this.db.exec("DELETE FROM background_task");
    this.db.exec("DELETE FROM todo");
    this.db.exec("DELETE FROM plan");
    this.db.exec("DELETE FROM task");
    this.db.exec("DELETE FROM event_log");
    this.db.exec("DELETE FROM artifact");
    this.db.exec("DELETE FROM surface_key");
    this.db.exec("DELETE FROM part");
    this.db.exec("DELETE FROM message");
    this.db.exec("DELETE FROM session");
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

function encodeCursor(id: string, time: number): string {
  return Buffer.from(JSON.stringify({ id, time })).toString("base64url");
}

function decodeCursor(cursor: string): { id: string; time: number } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
    id: string;
    time: number;
  };
}
