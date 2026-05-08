import type { Task } from "../task/index.js";
import type { Todo } from "../todo/index.js";

export namespace Storage {
  export interface TaskSubAdapter {
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
      listByStatus(status: Task.RunStatus[]): Task.Run[];
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

  export interface TodoSubAdapter {
    upsertAll(sessionId: string, todos: Todo.Info[]): Promise<void>;
    list(sessionId: string): Promise<Todo.Info[]>;
    deleteAll(sessionId: string): Promise<void>;
  }
}
