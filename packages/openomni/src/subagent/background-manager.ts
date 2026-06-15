import type { Subagent } from "@openomni/protocol";
import { startSweep, stopSweep } from "./abort-registry";
import {
  backgroundLaunchFailureReason,
  createBackgroundLaunchDescriptor,
  publishBackgroundTaskCancelled,
} from "./background-manager-events.js";
import { createBackgroundQueue } from "./background-manager-queue.js";
import { createBackgroundRunner } from "./background-manager-runner.js";
import {
  activeBackgroundTasks,
  cleanupExpiredBackgroundTasks,
  createBackgroundManagerState,
  getBackgroundResult,
  getBackgroundTask,
  listBackgroundTasksByParent,
  makeFailedBackgroundTask,
} from "./background-manager-state.js";
import {
  type BackgroundLaunchInput,
  type BackgroundManagerConfig,
  type BackgroundManagerInstance,
  resolveBackgroundManagerConfig,
} from "./background-manager-types.js";
import { BackgroundStore } from "./background-store.js";
import { BackgroundLimitsMiddleware } from "./middleware/background-limits.js";

type LaunchInput = BackgroundLaunchInput;
type Config = BackgroundManagerConfig;

export const BackgroundManager = {
  create(config?: Config): BackgroundManagerInstance {
    const resolvedConfig = resolveBackgroundManagerConfig(config);
    const state = createBackgroundManagerState();
    const queue = createBackgroundQueue(resolvedConfig.maxConcurrentTotal);
    const cleanup = () => cleanupExpiredBackgroundTasks(state, resolvedConfig.taskTtlMs);
    const drainQueue = () => {
      queue.drain({
        getTask: (taskId) => state.tasks.get(taskId),
        spawnTask: (taskId, input) => {
          void runner.spawnTask(taskId, input);
        },
      });
    };
    const runner = createBackgroundRunner({
      config: resolvedConfig,
      state,
      queue,
      drainQueue,
    });

    let launchLock: Promise<void> = Promise.resolve();

    async function withLaunchLock<T>(fn: () => Promise<T>): Promise<T> {
      const previous = launchLock;
      let releaseLock: (() => void) | undefined;
      launchLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      await previous;

      try {
        return await fn();
      } finally {
        releaseLock?.();
      }
    }

    const cleanupInterval = setInterval(cleanup, 60_000);
    startSweep();

    async function launch(input: LaunchInput): Promise<Subagent.BackgroundTask> {
      return withLaunchLock(async () => {
        const depth = input.depth ?? 0;
        const taskInput: LaunchInput = { ...input, depth };
        const resourceDescriptor = createBackgroundLaunchDescriptor(input.agentName);
        const policy = await BackgroundLimitsMiddleware.evaluatePreLaunch({
          input: taskInput,
          activeTasks: activeBackgroundTasks(state),
          activeCount: queue.activeCount(),
          pendingQueueSize: queue.pendingSize(),
          maxConcurrentPerAgent: resolvedConfig.maxConcurrentPerAgent,
          maxConcurrentTotal: resolvedConfig.maxConcurrentTotal,
          maxDepth: resolvedConfig.maxDepth,
          maxDescendants: resolvedConfig.maxDescendants,
          maxQueueSize: resolvedConfig.maxQueueSize,
          resourceDescriptor,
        });
        const launchFailureReason = backgroundLaunchFailureReason(policy.verdict);
        if (launchFailureReason !== undefined) {
          return makeFailedBackgroundTask(taskInput, launchFailureReason);
        }

        const id = `bg_${crypto.randomUUID().slice(0, 8)}`;
        const task: Subagent.BackgroundTask = {
          id,
          agentName: taskInput.agentName,
          prompt: taskInput.prompt,
          status: "pending",
          parentSessionId: taskInput.parentSessionId,
          queuedAt: Date.now(),
          depth,
        };
        state.tasks.set(id, task);

        if (policy.shouldQueue) {
          queue.enqueue({ input: taskInput, id });
          drainQueue();
          return state.tasks.get(id) ?? task;
        }

        queue.markActive(id);
        await runner.spawnTask(id, taskInput);
        return state.tasks.get(id) ?? task;
      });
    }

    async function cancel(taskId: string): Promise<boolean> {
      const task = state.tasks.get(taskId);
      if (task === undefined) return false;
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
        return false;

      queue.remove(taskId);
      state.controllers.get(taskId)?.abort();
      state.taskUnsubs.get(taskId)?.();
      state.taskUnsubs.delete(taskId);
      state.controllers.delete(taskId);

      const cancelled: Subagent.BackgroundTask = {
        ...task,
        status: "cancelled",
        completedAt: Date.now(),
      };
      state.tasks.set(taskId, cancelled);
      BackgroundStore.persist(cancelled);
      queue.releaseActive(taskId);

      publishBackgroundTaskCancelled(taskId);
      drainQueue();

      return true;
    }

    return {
      launch,
      getTask: (taskId) => getBackgroundTask(state, taskId),
      getResult: (taskId) => getBackgroundResult(state, taskId),
      cancel,
      listByParent: (parentSessionId) => listBackgroundTasksByParent(state, parentSessionId),
      cleanup,
      stats: () => ({
        active: queue.activeCount(),
        pending: queue.pendingSize(),
        total: state.tasks.size,
      }),
      dispose: () => {
        clearInterval(cleanupInterval);
        stopSweep();
      },
    };
  },
};
