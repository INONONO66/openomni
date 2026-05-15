import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, WorkItem, Storage as ProtocolStorage } from "@openomni/protocol";
import { getPartStartTime } from "./part-time";
import type { SessionInfo } from "../session/info";
import type { WorkerRunStateStore } from "../worker-run/state-store";
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
  "0008_unified_observability/migration.sql",
  "0009_work_item/migration.sql",
];

function applyPragmas(db: Database): void {
  db.query("PRAGMA journal_mode = WAL").get();
  db.query("PRAGMA synchronous = NORMAL").get();
  db.query("PRAGMA busy_timeout = 5000").get();
  db.query("PRAGMA cache_size = -64000").get();
  db.query("PRAGMA mmap_size = 268435456").get();
  db.query("PRAGMA temp_store = MEMORY").get();
  db.query("PRAGMA foreign_keys = ON").get();
  db.query("PRAGMA wal_checkpoint(PASSIVE)").get();
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

  workerRunState: WorkerRunStateStore.Adapter = {
    create: (sessionId: string, record: WorkerRunStateStore.CreateRecord): void => {
      const now = Date.now();
      const timeCreated = record.timeCreated ?? now;
      const timeUpdated = record.timeUpdated ?? timeCreated;
      this.db
        .query(
          `INSERT INTO worker_run_state (
             run_id,
             session_id,
             parent_session_id,
             agent_name,
             status,
             title,
             prompt,
             resume_count,
             assigned_step_id,
             error,
             time_created,
             time_updated
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.runId,
          sessionId,
          record.parentSessionId ?? null,
          record.agentName,
          record.status,
          record.title,
          record.prompt,
          record.resumeCount ?? 0,
          record.assignedStepId ?? null,
          record.error ?? null,
          timeCreated,
          timeUpdated,
        );
    },

    updateStatus: (
      sessionId: string,
      runId: string,
      status: WorkerRunStateStore.Status,
      extra?: WorkerRunStateStore.StatusExtra,
    ): boolean => {
      const result = this.db
        .query(
          `UPDATE worker_run_state
           SET status = ?,
               error = COALESCE(?, error),
               resume_count = CASE
                 WHEN status = 'waiting_input' AND ? = 'running' THEN resume_count + 1
                 ELSE resume_count
               END,
               time_updated = ?
           WHERE session_id = ? AND run_id = ?`,
        )
        .run(status, extra?.error ?? null, status, Date.now(), sessionId, runId);
      return result.changes > 0;
    },

    get: (sessionId: string, runId: string): WorkerRunStateStore.Record | undefined => {
      const row = this.db
        .query(
          `SELECT run_id, session_id, parent_session_id, agent_name, status, title, prompt,
                  resume_count, assigned_step_id, error, time_created, time_updated
           FROM worker_run_state
           WHERE session_id = ? AND run_id = ?`,
        )
        .get(sessionId, runId) as WorkerRunStateRow | null;
      return row ? toWorkerRunStateRecord(row) : undefined;
    },

    listBySession: (sessionId: string): WorkerRunStateStore.Record[] => {
      const rows = this.db
        .query(
          `SELECT run_id, session_id, parent_session_id, agent_name, status, title, prompt,
                  resume_count, assigned_step_id, error, time_created, time_updated
           FROM worker_run_state
           WHERE session_id = ?
           ORDER BY time_created ASC, rowid ASC`,
        )
        .all(sessionId) as WorkerRunStateRow[];
      return rows.map(toWorkerRunStateRecord);
    },

    listByStatus: (status: WorkerRunStateStore.Status): WorkerRunStateStore.Record[] => {
      const rows = this.db
        .query(
          `SELECT run_id, session_id, parent_session_id, agent_name, status, title, prompt,
                  resume_count, assigned_step_id, error, time_created, time_updated
           FROM worker_run_state
           WHERE status = ?
           ORDER BY time_created ASC, rowid ASC`,
        )
        .all(status) as WorkerRunStateRow[];
      return rows.map(toWorkerRunStateRecord);
    },
  };

  workItem: ProtocolStorage.WorkItemSubAdapter = {
    get: (hash: string): WorkItem.Info | undefined => {
      const row = this.db.query("SELECT data FROM work_item WHERE hash = ?").get(hash) as {
        data: string;
      } | null;
      return row ? (JSON.parse(row.data) as WorkItem.Info) : undefined;
    },

    set: (hash: string, item: WorkItem.Info): void => {
      const now = Date.now();
      const status =
        item.timestamps.cancelled !== undefined
          ? "cancelled"
          : item.timestamps.failed !== undefined
            ? "failed"
            : item.timestamps.completed !== undefined
              ? "completed"
              : item.blockers.some((blocker) => blocker.resolvedAt === undefined)
                ? "blocked"
                : item.timestamps.started !== undefined
                  ? "running"
                  : "pending";
      this.db
        .query(
          `INSERT INTO work_item (hash, data, status, assignee_id, session_id, parent_hash, source_channel, time_created, time_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hash) DO UPDATE SET
             data = excluded.data,
             status = excluded.status,
             assignee_id = excluded.assignee_id,
             session_id = excluded.session_id,
             parent_hash = excluded.parent_hash,
             source_channel = excluded.source_channel,
             time_updated = excluded.time_updated`,
        )
        .run(
          hash,
          JSON.stringify(item),
          status,
          item.assigneeId ?? null,
          item.sessionId ?? null,
          item.relations.parentHash ?? null,
          item.sourceChannel,
          item.timestamps.created,
          now,
        );
    },

    list: (filter?: ProtocolStorage.WorkItemListFilter): WorkItem.Info[] => {
      const conditions: string[] = [];
      const params: (string | null)[] = [];

      if (filter?.status && filter.status.length > 0) {
        const placeholders = filter.status.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        params.push(...filter.status);
      }
      if (filter?.assigneeId !== undefined) {
        conditions.push("assignee_id = ?");
        params.push(filter.assigneeId);
      }
      if (filter?.sessionId !== undefined) {
        conditions.push("session_id = ?");
        params.push(filter.sessionId);
      }
      if (filter?.parentHash !== undefined) {
        conditions.push("parent_hash = ?");
        params.push(filter.parentHash);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = this.db
        .query(`SELECT data FROM work_item ${where} ORDER BY time_created ASC`)
        .all(...params) as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as WorkItem.Info);
    },

    remove: (hash: string): boolean => {
      const result = this.db.query("DELETE FROM work_item WHERE hash = ?").run(hash);
      return result.changes > 0;
    },
  };

  clear(): void {
    this.db.query("DELETE FROM worker_run_state").run();
    this.db.query("DELETE FROM bus_event").run();
    this.db.query("DELETE FROM background_task").run();
    this.db.query("DELETE FROM work_item").run();
    this.db.query("DELETE FROM todo").run();
    this.db.query("DELETE FROM plan").run();
    this.db.query("DELETE FROM task").run();
    this.db.query("DELETE FROM artifact").run();
    this.db.query("DELETE FROM surface_key").run();
    this.db.query("DELETE FROM part").run();
    this.db.query("DELETE FROM message").run();
    this.db.query("DELETE FROM session").run();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

type WorkerRunStateRow = {
  run_id: string;
  session_id: string;
  parent_session_id: string | null;
  agent_name: string;
  status: WorkerRunStateStore.Status;
  title: string;
  prompt: string;
  resume_count: number;
  assigned_step_id: string | null;
  error: string | null;
  time_created: number;
  time_updated: number;
};

function toWorkerRunStateRecord(row: WorkerRunStateRow): WorkerRunStateStore.Record {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id ?? undefined,
    agentName: row.agent_name,
    status: row.status,
    title: row.title,
    prompt: row.prompt,
    resumeCount: row.resume_count,
    assignedStepId: row.assigned_step_id ?? undefined,
    error: row.error ?? undefined,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  };
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
