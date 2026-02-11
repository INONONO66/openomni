import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { TaskStore, TaskListFilter, RunListOptions } from "./storage";
import type { Task, TaskRun } from "./types";

export class FileTaskStore implements TaskStore {
  private tasks = new Map<string, Task.Info>();
  private runs = new Map<string, TaskRun>();
  private taskRuns = new Map<string, string[]>(); // taskId -> runId[]
  private idempotencyIndex = new Map<string, string>(); // idempotencyKey -> runId
  private statusIndex = new Map<TaskRun["status"], Set<string>>(); // status -> Set<runId>

  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.loadFromDisk();
  }

  // ===========================================================
  // task sub-object
  // ===========================================================

  task = {
    get: (id: string): Task.Info | undefined => {
      return this.tasks.get(id);
    },
    set: (id: string, info: Task.Info): void => {
      this.tasks.set(id, info);
      this.flushTasks();
    },
    list: (filter?: TaskListFilter): Task.Info[] => {
      let tasks = Array.from(this.tasks.values());

      if (!filter) return tasks;

      if (filter.status) {
        const statuses = Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
        tasks = tasks.filter((t) => statuses.includes(t.status));
      }

      if (filter.ownerId) {
        tasks = tasks.filter((t) => t.owner.id === filter.ownerId);
      }

      if (filter.assignedAgentId) {
        tasks = tasks.filter(
          (t) => t.assignedAgentId === filter.assignedAgentId,
        );
      }

      if (filter.tags && filter.tags.length > 0) {
        tasks = tasks.filter((t) =>
          filter.tags!.every((tag) => t.tags?.includes(tag)),
        );
      }

      return tasks;
    },
    remove: (id: string): boolean => {
      const runIds = this.taskRuns.get(id);
      if (runIds) {
        for (const runId of runIds) {
          const run = this.runs.get(runId);
          if (run) {
            this.statusIndex.get(run.status)?.delete(runId);
            this.idempotencyIndex.delete(run.idempotencyKey);
            this.runs.delete(runId);
          }
        }
        this.taskRuns.delete(id);
      }

      const deleted = this.tasks.delete(id);
      this.flushAll();
      return deleted;
    },
  };

  // ===========================================================
  // run sub-object
  // ===========================================================

  run = {
    get: (runId: string): TaskRun | undefined => {
      return this.runs.get(runId);
    },
    set: (taskId: string, run: TaskRun): void => {
      const existingRun = this.runs.get(run.runId);

      if (existingRun && existingRun.status !== run.status) {
        this.statusIndex.get(existingRun.status)?.delete(run.runId);
      }

      if (!this.statusIndex.has(run.status)) {
        this.statusIndex.set(run.status, new Set());
      }
      this.statusIndex.get(run.status)!.add(run.runId);

      this.idempotencyIndex.set(run.idempotencyKey, run.runId);
      this.runs.set(run.runId, run);

      const runIds = this.taskRuns.get(taskId) ?? [];
      if (!runIds.includes(run.runId)) {
        runIds.push(run.runId);
        this.taskRuns.set(taskId, runIds);
      }

      this.flushRuns();
      this.flushTaskRuns();
      this.flushIdempotencyIndex();
      this.flushStatusIndex();
    },
    list: (taskId: string, opts?: RunListOptions): TaskRun[] => {
      const runIds = this.taskRuns.get(taskId) ?? [];
      let runs = runIds
        .map((id) => this.runs.get(id))
        .filter((r): r is TaskRun => r !== undefined);

      if (opts?.sortBy) {
        const sortBy = opts.sortBy;
        const sortOrder = opts.sortOrder ?? "desc";
        runs.sort((a, b) => {
          const aVal = a[sortBy] ?? 0;
          const bVal = b[sortBy] ?? 0;
          return sortOrder === "asc" ? aVal - bVal : bVal - aVal;
        });
      }

      if (opts?.offset !== undefined || opts?.limit !== undefined) {
        const offset = opts.offset ?? 0;
        const limit = opts.limit ?? runs.length;
        runs = runs.slice(offset, offset + limit);
      }

      return runs;
    },
    listByStatus: (status: TaskRun["status"][]): TaskRun[] => {
      const runIds = new Set<string>();
      for (const s of status) {
        const ids = this.statusIndex.get(s);
        if (ids) {
          for (const id of ids) {
            runIds.add(id);
          }
        }
      }
      return Array.from(runIds)
        .map((id) => this.runs.get(id))
        .filter((r): r is TaskRun => r !== undefined);
    },
    remove: (runId: string): boolean => {
      const run = this.runs.get(runId);
      if (!run) return false;

      this.statusIndex.get(run.status)?.delete(runId);
      this.idempotencyIndex.delete(run.idempotencyKey);

      const runIds = this.taskRuns.get(run.taskId);
      if (runIds) {
        const idx = runIds.indexOf(runId);
        if (idx >= 0) {
          runIds.splice(idx, 1);
        }
      }

      const deleted = this.runs.delete(runId);
      this.flushRuns();
      this.flushTaskRuns();
      this.flushIdempotencyIndex();
      this.flushStatusIndex();
      return deleted;
    },
    getByIdempotencyKey: (key: string): TaskRun | undefined => {
      const runId = this.idempotencyIndex.get(key);
      return runId ? this.runs.get(runId) : undefined;
    },
  };

  // ===========================================================
  // Disk I/O — load
  // ===========================================================

  private loadFromDisk(): void {
    this.tasks = this.readMapFile<Task.Info>("tasks.json");
    this.runs = this.readMapFile<TaskRun>("runs.json");
    this.taskRuns = this.readMapFile<string[]>("taskRuns.json");
    this.idempotencyIndex = this.readMapFile<string>("idempotencyIndex.json");
    this.loadStatusIndex();
  }

  private loadStatusIndex(): void {
    const path = join(this.dir, "statusIndex.json");
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<
        string,
        string[]
      >;
      this.statusIndex = new Map();
      for (const [status, ids] of Object.entries(raw)) {
        this.statusIndex.set(status as TaskRun["status"], new Set(ids));
      }
    } catch {
      this.rebuildStatusIndex();
    }
  }

  private rebuildStatusIndex(): void {
    this.statusIndex = new Map();
    for (const run of this.runs.values()) {
      if (!this.statusIndex.has(run.status)) {
        this.statusIndex.set(run.status, new Set());
      }
      this.statusIndex.get(run.status)!.add(run.runId);
    }
  }

  private readMapFile<V>(filename: string): Map<string, V> {
    const path = join(this.dir, filename);
    if (!existsSync(path)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, V>;
      return new Map(Object.entries(raw));
    } catch {
      return new Map();
    }
  }

  // ===========================================================
  // Disk I/O — flush (atomic write: tmp → rename)
  // ===========================================================

  private atomicWrite(filename: string, data: string): void {
    const target = join(this.dir, filename);
    const tmp = target + ".tmp";
    try {
      writeFileSync(tmp, data, "utf-8");
      renameSync(tmp, target);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* noop */
      }
      throw err;
    }
  }

  private flushMap<V>(filename: string, map: Map<string, V>): void {
    this.atomicWrite(
      filename,
      JSON.stringify(Object.fromEntries(map), null, 2),
    );
  }

  private flushTasks(): void {
    this.flushMap("tasks.json", this.tasks);
  }

  private flushRuns(): void {
    this.flushMap("runs.json", this.runs);
  }

  private flushTaskRuns(): void {
    this.flushMap("taskRuns.json", this.taskRuns);
  }

  private flushIdempotencyIndex(): void {
    this.flushMap("idempotencyIndex.json", this.idempotencyIndex);
  }

  private flushStatusIndex(): void {
    const obj: Record<string, string[]> = {};
    for (const [status, ids] of this.statusIndex) {
      obj[status] = Array.from(ids);
    }
    this.atomicWrite("statusIndex.json", JSON.stringify(obj, null, 2));
  }

  private flushAll(): void {
    this.flushTasks();
    this.flushRuns();
    this.flushTaskRuns();
    this.flushIdempotencyIndex();
    this.flushStatusIndex();
  }

  clear(): void {
    this.tasks.clear();
    this.runs.clear();
    this.taskRuns.clear();
    this.idempotencyIndex.clear();
    this.statusIndex.clear();
    this.flushAll();
  }
}
