import type { Subagent } from "@openomni/protocol";
import { BackgroundStore } from "./background-store.js";
import type { BackgroundLaunchInput } from "./background-manager-types.js";

export type BackgroundManagerState = {
  readonly tasks: Map<string, Subagent.BackgroundTask>;
  readonly results: Map<string, Subagent.BackgroundTaskResult>;
  readonly controllers: Map<string, AbortController>;
  readonly taskUnsubs: Map<string, () => void>;
};

export function createBackgroundManagerState(): BackgroundManagerState {
  const state: BackgroundManagerState = {
    tasks: new Map<string, Subagent.BackgroundTask>(),
    results: new Map<string, Subagent.BackgroundTaskResult>(),
    controllers: new Map<string, AbortController>(),
    taskUnsubs: new Map<string, () => void>(),
  };

  for (const interrupted of BackgroundStore.loadInterrupted()) {
    state.tasks.set(interrupted.id, interrupted);
    state.results.set(interrupted.id, { taskId: interrupted.id, status: "failed" });
  }

  return state;
}

export function activeBackgroundTasks(state: BackgroundManagerState): Subagent.BackgroundTask[] {
  return [...state.tasks.values()].filter((task) => {
    return task.status === "running" || task.status === "pending";
  });
}

export function makeFailedBackgroundTask(
  input: BackgroundLaunchInput,
  error: string,
): Subagent.BackgroundTask {
  return {
    id: `bg_${crypto.randomUUID().slice(0, 8)}`,
    agentName: input.agentName,
    prompt: input.prompt,
    status: "failed",
    parentSessionId: input.parentSessionId,
    queuedAt: Date.now(),
    error,
    depth: input.depth ?? 0,
  };
}

export function cleanupExpiredBackgroundTasks(
  state: BackgroundManagerState,
  taskTtlMs: number,
): void {
  const now = Date.now();
  for (const [id, task] of state.tasks) {
    if (task.completedAt !== undefined && now - task.completedAt > taskTtlMs) {
      state.tasks.delete(id);
      state.results.delete(id);
      state.controllers.delete(id);
      state.taskUnsubs.delete(id);
      BackgroundStore.deleteTask(id);
    }
  }
}

export function getBackgroundTask(
  state: BackgroundManagerState,
  taskId: string,
): Subagent.BackgroundTask | undefined {
  return state.tasks.get(taskId) ?? BackgroundStore.getTask(taskId);
}

export function getBackgroundResult(
  state: BackgroundManagerState,
  taskId: string,
): Subagent.BackgroundTaskResult | undefined {
  return state.results.get(taskId) ?? BackgroundStore.getResult(taskId);
}

export function listBackgroundTasksByParent(
  state: BackgroundManagerState,
  parentSessionId: string,
): Subagent.BackgroundTask[] {
  return [...state.tasks.values()].filter((task) => task.parentSessionId === parentSessionId);
}
