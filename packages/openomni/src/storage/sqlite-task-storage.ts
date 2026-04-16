import { Database } from "bun:sqlite";
import type { TaskStore, TaskListFilter, RunListOptions } from "./task-storage";
import type { Task } from "./task-types";

type TaskRow = {
  id: string;
  owner_type: string;
  owner_id: string;
  status: string;
  data: string;
  time_created: number;
  time_updated: number;
};

type RunRow = {
  id: string;
  task_id: string;
  status: string;
  trigger: string | null;
  data: string;
  time_created: number;
  time_updated: number;
};

type IdempotencyRow = {
  run_id: string;
};

const SCHEMA = `
PRAGMA journal_mode  = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA busy_timeout  = 5000;
PRAGMA cache_size    = -32000;
PRAGMA foreign_keys  = ON;
PRAGMA temp_store    = MEMORY;

CREATE TABLE IF NOT EXISTS task (
  id           TEXT PRIMARY KEY,
  owner_type   TEXT,
  owner_id     TEXT,
  status       TEXT NOT NULL,
  data         TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_run (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  trigger      TEXT,
  data         TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_idempotency (
  key          TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES task_run(id) ON DELETE CASCADE,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_status     ON task(status, time_created);
CREATE INDEX IF NOT EXISTS idx_task_run_task   ON task_run(task_id);
CREATE INDEX IF NOT EXISTS idx_task_run_status ON task_run(status, time_created);
`;

function rowToInfo(row: TaskRow): Task.Info {
  return JSON.parse(row.data) as Task.Info;
}

function rowToRun(row: RunRow): Task.Run {
  return JSON.parse(row.data) as Task.Run;
}

function prepareStatements(db: Database) {
  return {
    taskGet: db.prepare<TaskRow, [string]>("SELECT * FROM task WHERE id = ?"),
    taskUpsert: db.prepare<void, [string, string, string, string, string, number, number]>(
      `INSERT INTO task (id, owner_type, owner_id, status, data, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_type   = excluded.owner_type,
         owner_id     = excluded.owner_id,
         status       = excluded.status,
         data         = excluded.data,
         time_updated = excluded.time_updated`,
    ),
    taskListAll: db.prepare<TaskRow, []>("SELECT * FROM task"),
    taskDelete: db.prepare<void, [string]>("DELETE FROM task WHERE id = ?"),
    runGet: db.prepare<RunRow, [string]>("SELECT * FROM task_run WHERE id = ?"),
    runUpsert: db.prepare<void, [string, string, string, string | null, string, number, number]>(
      `INSERT INTO task_run (id, task_id, status, trigger, data, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status       = excluded.status,
         trigger      = excluded.trigger,
         data         = excluded.data,
         time_updated = excluded.time_updated`,
    ),
    runListByTask: db.prepare<RunRow, [string]>("SELECT * FROM task_run WHERE task_id = ?"),
    runDelete: db.prepare<void, [string]>("DELETE FROM task_run WHERE id = ?"),
    idempotencyGet: db.prepare<IdempotencyRow, [string]>(
      "SELECT run_id FROM task_idempotency WHERE key = ?",
    ),
    idempotencyUpsert: db.prepare<void, [string, string, number]>(
      `INSERT INTO task_idempotency (key, run_id, time_created)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET run_id = excluded.run_id`,
    ),
  };
}

export class SqliteTaskStore implements TaskStore {
  private readonly db: Database;
  private readonly stmts: ReturnType<typeof prepareStatements>;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec(SCHEMA);
    this.stmts = prepareStatements(this.db);
  }

  task = {
    get: (id: string): Task.Info | undefined => {
      const row = this.stmts.taskGet.get(id);
      return row ? rowToInfo(row) : undefined;
    },

    set: (id: string, info: Task.Info): void => {
      const now = Date.now();
      this.stmts.taskUpsert.run(
        id,
        info.owner.type,
        info.owner.id,
        info.status,
        JSON.stringify(info),
        now,
        now,
      );
    },

    list: (filter?: TaskListFilter): Task.Info[] => {
      let tasks = this.stmts.taskListAll.all().map(rowToInfo);

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
      const existing = this.stmts.taskGet.get(id);
      if (!existing) return false;
      // CASCADE in schema auto-removes task_run rows and their task_idempotency entries
      this.stmts.taskDelete.run(id);
      return true;
    },
  };

  run = {
    get: (runId: string): Task.Run | undefined => {
      const row = this.stmts.runGet.get(runId);
      return row ? rowToRun(row) : undefined;
    },

    set: (taskId: string, run: Task.Run): void => {
      const now = Date.now();
      const setRun = this.db.transaction(() => {
        this.stmts.runUpsert.run(
          run.runId,
          taskId,
          run.status,
          JSON.stringify(run.trigger),
          JSON.stringify(run),
          now,
          now,
        );
        this.stmts.idempotencyUpsert.run(run.idempotencyKey, run.runId, now);
      });
      setRun();
    },

    list: (taskId: string, opts?: RunListOptions): Task.Run[] => {
      let runs = this.stmts.runListByTask.all(taskId).map(rowToRun);

      if (opts?.sortBy) {
        const { sortBy } = opts;
        const dir = opts.sortOrder === "asc" ? 1 : -1;
        runs.sort((a, b) => dir * ((a[sortBy] ?? 0) - (b[sortBy] ?? 0)));
      }
      if (opts?.offset || opts?.limit) {
        const start = opts.offset ?? 0;
        runs = runs.slice(start, start + (opts.limit ?? runs.length));
      }

      return runs;
    },

    listByStatus: (statuses: Task.Run["status"][]): Task.Run[] => {
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => "?").join(", ");
      const rows = this.db
        .prepare<RunRow, string[]>(`SELECT * FROM task_run WHERE status IN (${placeholders})`)
        .all(...statuses);
      return rows.map(rowToRun);
    },

    remove: (runId: string): boolean => {
      const existing = this.stmts.runGet.get(runId);
      if (!existing) return false;
      // CASCADE auto-removes task_idempotency entry
      this.stmts.runDelete.run(runId);
      return true;
    },

    getByIdempotencyKey: (key: string): Task.Run | undefined => {
      const row = this.stmts.idempotencyGet.get(key);
      if (!row) return undefined;
      return this.run.get(row.run_id);
    },
  };

  clear(): void {
    this.db.exec("DELETE FROM task");
    // CASCADE removes task_run and task_idempotency
  }

  close(): void {
    this.db.close();
  }
}
