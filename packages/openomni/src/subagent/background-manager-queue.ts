import type { Subagent } from "@openomni/protocol";
import type { BackgroundLaunchInput, QueuedBackgroundLaunch } from "./background-manager-types.js";

export type BackgroundQueue = {
  enqueue(item: QueuedBackgroundLaunch): void;
  remove(taskId: string): void;
  drain(input: {
    readonly getTask: (taskId: string) => Subagent.BackgroundTask | undefined;
    readonly spawnTask: (taskId: string, input: BackgroundLaunchInput) => void;
  }): void;
  markActive(taskId: string): void;
  releaseActive(taskId: string): void;
  activeCount(): number;
  pendingSize(): number;
};

export function createBackgroundQueue(maxConcurrentTotal: number): BackgroundQueue {
  const pendingQueue: QueuedBackgroundLaunch[] = [];
  const activeTaskIds = new Set<string>();
  let activeCount = 0;

  return {
    enqueue(item) {
      pendingQueue.push(item);
    },
    remove(taskId) {
      const queueIdx = pendingQueue.findIndex((item) => item.id === taskId);
      if (queueIdx !== -1) {
        pendingQueue.splice(queueIdx, 1);
      }
    },
    drain(input) {
      while (pendingQueue.length > 0 && activeCount < maxConcurrentTotal) {
        const next = pendingQueue.shift();
        if (next === undefined) break;

        const task = input.getTask(next.id);
        if (task === undefined || task.status !== "pending") continue;

        this.markActive(next.id);
        input.spawnTask(next.id, next.input);
      }
    },
    markActive(taskId) {
      if (activeTaskIds.has(taskId)) return;
      activeTaskIds.add(taskId);
      activeCount++;
    },
    releaseActive(taskId) {
      if (!activeTaskIds.delete(taskId)) return;
      activeCount--;
    },
    activeCount() {
      return activeCount;
    },
    pendingSize() {
      return pendingQueue.length;
    },
  };
}
