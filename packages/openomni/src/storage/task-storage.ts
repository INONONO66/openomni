import type { Task } from "./task-types";

export interface TaskStore {
  task: {
    get(id: string): Task.Info | undefined;
    set(id: string, info: Task.Info): void;
    list(filter?: TaskListFilter): Task.Info[];
    remove(id: string): boolean;
  };
  run: {
    get(runId: string): Task.Run | undefined;
    set(taskId: string, run: Task.Run): void;
    list(taskId: string, opts?: RunListOptions): Task.Run[];
    listByStatus(status: Task.Run["status"][]): Task.Run[];
    remove(runId: string): boolean;
    getByIdempotencyKey(key: string): Task.Run | undefined;
  };
}

export interface TaskListFilter {
  status?: Task.Status | Task.Status[];
  ownerId?: string;
  assignedAgentId?: string;
  tags?: string[];
}

export interface RunListOptions {
  limit?: number;
  offset?: number;
  sortBy?: "scheduledAt" | "startedAt" | "endedAt";
  sortOrder?: "asc" | "desc";
}

export class InMemoryTaskStore implements TaskStore {
  private tasks = new Map<string, Task.Info>();
  private runs = new Map<string, Task.Run>();
  private taskRuns = new Map<string, string[]>(); // taskId -> runId[]
  private idempotencyIndex = new Map<string, string>(); // idempotencyKey -> runId
  private statusIndex = new Map<Task.Run["status"], Set<string>>(); // status -> Set<runId>

  task = {
    get: (id: string): Task.Info | undefined => {
      return this.tasks.get(id);
    },
    set: (id: string, info: Task.Info): void => {
      this.tasks.set(id, info);
    },
    list: (filter?: TaskListFilter): Task.Info[] => {
      let tasks = Array.from(this.tasks.values());

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

      return this.tasks.delete(id);
    },
  };

  run = {
    get: (runId: string): Task.Run | undefined => {
      return this.runs.get(runId);
    },
    set: (taskId: string, run: Task.Run): void => {
      const existingRun = this.runs.get(run.runId);

      if (existingRun && existingRun.status !== run.status) {
        this.statusIndex.get(existingRun.status)?.delete(run.runId);
      }

      if (!this.statusIndex.has(run.status)) {
        this.statusIndex.set(run.status, new Set());
      }
      this.statusIndex.get(run.status)?.add(run.runId);

      this.idempotencyIndex.set(run.idempotencyKey, run.runId);
      this.runs.set(run.runId, run);

      const runIds = this.taskRuns.get(taskId) ?? [];
      if (!runIds.includes(run.runId)) {
        runIds.push(run.runId);
        this.taskRuns.set(taskId, runIds);
      }
    },
    list: (taskId: string, opts?: RunListOptions): Task.Run[] => {
      const runIds = this.taskRuns.get(taskId) ?? [];
      let runs = runIds
        .map((id) => this.runs.get(id))
        .filter((r): r is Task.Run => r !== undefined);

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
      const collected = new Set<string>();
      for (const s of statuses) this.statusIndex.get(s)?.forEach((id) => collected.add(id));
      return [...collected]
        .map((id) => this.runs.get(id))
        .filter((r): r is Task.Run => r !== undefined);
    },
    remove: (runId: string): boolean => {
      const run = this.runs.get(runId);
      if (!run) return false;
      this.statusIndex.get(run.status)?.delete(runId);
      this.idempotencyIndex.delete(run.idempotencyKey);
      const runIds = this.taskRuns.get(run.taskId);
      if (runIds)
        this.taskRuns.set(
          run.taskId,
          runIds.filter((id) => id !== runId),
        );
      return this.runs.delete(runId);
    },
    getByIdempotencyKey: (key: string): Task.Run | undefined => {
      const runId = this.idempotencyIndex.get(key);
      return runId ? this.runs.get(runId) : undefined;
    },
  };

  clear(): void {
    this.tasks.clear();
    this.runs.clear();
    this.taskRuns.clear();
    this.idempotencyIndex.clear();
    this.statusIndex.clear();
  }
}

export namespace TaskStorage {
  let adapter: TaskStore = new InMemoryTaskStore();

  export function configure(newAdapter: TaskStore): void {
    adapter = newAdapter;
  }

  export function getAdapter(): TaskStore {
    return adapter;
  }

  export function reset(): void {
    adapter = new InMemoryTaskStore();
  }
}
