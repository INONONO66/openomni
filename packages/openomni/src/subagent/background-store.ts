import type { Subagent } from "@openomni/protocol";
import { Storage } from "@openomni/session";

function adapter() {
  return Storage.get().backgroundTask;
}

function serialize(task: Subagent.BackgroundTask): string {
  return JSON.stringify(task);
}

function deserialize(data: string): Subagent.BackgroundTask {
  return JSON.parse(data) as Subagent.BackgroundTask;
}

export namespace BackgroundStore {
  export function persist(task: Subagent.BackgroundTask, output?: string): void {
    adapter()?.upsert(task.id, task.status, task.parentSessionId, serialize(task), output);
  }

  export function getTask(taskId: string): Subagent.BackgroundTask | undefined {
    const row = adapter()?.get(taskId);
    if (!row) return undefined;
    return deserialize(row.data);
  }

  export function getResult(taskId: string): Subagent.BackgroundTaskResult | undefined {
    const row = adapter()?.get(taskId);
    if (!row) return undefined;
    const task = deserialize(row.data);
    if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
      return undefined;
    }
    return {
      taskId,
      status: task.status,
      output: row.output,
    };
  }

  export function loadInterrupted(): Subagent.BackgroundTask[] {
    const store = adapter();
    if (!store) return [];

    const rows = store.listByStatus("running", "pending");
    const interrupted: Subagent.BackgroundTask[] = [];

    for (const row of rows) {
      const original = deserialize(row.data);
      const failed: Subagent.BackgroundTask = {
        ...original,
        status: "failed",
        completedAt: Date.now(),
        error: "worker restarted",
      };
      // Mark as interrupted in DB (distinct from a normal failure, for observability)
      store.upsert(failed.id, "interrupted", failed.parentSessionId, serialize(failed));
      interrupted.push(failed);
    }

    return interrupted;
  }
}
