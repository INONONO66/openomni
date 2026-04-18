// Scheduled-task execution tracking: triggers (cron/interval/once/event/manual),
// idempotency, retry attempts, and checkpoints. Separate from WorkerRun in
// @openomni/session, which tracks subagent execution lifecycle per session.

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

export namespace TaskStorage {
  let adapter: TaskStore | undefined;

  export function configure(newAdapter: TaskStore): void {
    adapter = newAdapter;
  }

  export function getAdapter(): TaskStore {
    if (!adapter) {
      throw new Error("TaskStorage not configured. Call TaskStorage.configure() first.");
    }
    return adapter;
  }
}
