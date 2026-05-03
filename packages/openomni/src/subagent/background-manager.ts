import { type Message, Subagent } from "@openomni/protocol";
import { Bus, Log, Session } from "@openomni/session";
import { startSweep, stopSweep } from "./abort-registry";
import { BackgroundStore } from "./background-store.js";
import { BackgroundLimitsMiddleware } from "./middleware/background-limits.js";
import { SubagentRuntime } from "./runtime.js";

type LaunchInput = {
  agentName: string;
  prompt: string;
  model: { provider: string; id: string };
  parentSessionId: string;
  depth?: number;
};

type Config = {
  maxConcurrentPerAgent?: number;
  maxConcurrentTotal?: number;
  maxDepth?: number;
  maxDescendants?: number;
  taskTtlMs?: number;
  maxQueueSize?: number;
  onTaskComplete?: (result: Subagent.BackgroundTaskResult) => void;
};

type BackgroundManagerInstance = {
  launch(input: LaunchInput): Promise<Subagent.BackgroundTask>;
  getTask(taskId: string): Subagent.BackgroundTask | undefined;
  getResult(taskId: string): Subagent.BackgroundTaskResult | undefined;
  cancel(taskId: string): Promise<boolean>;
  listByParent(parentSessionId: string): Subagent.BackgroundTask[];
  cleanup(): void;
  stats(): { active: number; pending: number; total: number };
  dispose(): void;
};

export const BackgroundManager = {
  create(config?: Config): BackgroundManagerInstance {
    const maxConcurrentPerAgent = config?.maxConcurrentPerAgent ?? 3;
    const maxConcurrentTotal = config?.maxConcurrentTotal ?? 10;
    const maxDepth = config?.maxDepth ?? 5;
    const maxDescendants = config?.maxDescendants ?? 10;
    const taskTtlMs = config?.taskTtlMs ?? 1_800_000;
    const maxQueueSize = config?.maxQueueSize ?? 100;
    const onTaskComplete = config?.onTaskComplete;

    const tasks = new Map<string, Subagent.BackgroundTask>();
    const results = new Map<string, Subagent.BackgroundTaskResult>();
    const controllers = new Map<string, AbortController>();
    const taskUnsubs = new Map<string, () => void>();

    type QueuedItem = { input: LaunchInput; id: string };
    const pendingQueue: QueuedItem[] = [];
    // Tracks spawning + running tasks synchronously (incremented before async spawn)
    let activeCount = 0;
    let launchLock: Promise<void> = Promise.resolve();

    for (const interrupted of BackgroundStore.loadInterrupted()) {
      tasks.set(interrupted.id, interrupted);
      results.set(interrupted.id, { taskId: interrupted.id, status: "failed" });
    }

    function activeTasks(): Subagent.BackgroundTask[] {
      return [...tasks.values()].filter((t) => t.status === "running" || t.status === "pending");
    }

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

    function makeFailedTask(input: LaunchInput, error: string): Subagent.BackgroundTask {
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

    function cleanup(): void {
      const now = Date.now();
      for (const [id, task] of tasks) {
        if (task.completedAt !== undefined && now - task.completedAt > taskTtlMs) {
          tasks.delete(id);
          results.delete(id);
          controllers.delete(id);
          taskUnsubs.delete(id);
          BackgroundStore.deleteTask(id);
        }
      }
    }

    const cleanupInterval = setInterval(cleanup, 60_000);
    startSweep();

    function drainQueue(): void {
      while (pendingQueue.length > 0 && activeCount < maxConcurrentTotal) {
        const next = pendingQueue.shift();
        if (!next) break;

        const task = tasks.get(next.id);
        // task may have been cancelled while queued
        if (!task || task.status !== "pending") continue;

        activeCount++;
        spawnTask(next.id, next.input, task);
      }
    }

    function spawnTask(
      id: string,
      input: LaunchInput,
      task: Subagent.BackgroundTask,
    ): Promise<void> {
      const controller = new AbortController();
      controllers.set(id, controller);

      return SubagentRuntime.spawnBackground({
        agentName: input.agentName,
        prompt: input.prompt,
        title: input.prompt.slice(0, 50),
        model: input.model,
        signal: controller.signal,
      }).then(
        ({ sessionId, runId }) => {
          const running: Subagent.BackgroundTask = {
            ...task,
            status: "running",
            sessionId,
            runId,
            startedAt: Date.now(),
          };
          tasks.set(id, running);
          BackgroundStore.persist(running);

          const runUnsubs: Array<() => void> = [];
          const cleanupRunSubs = () => runUnsubs.forEach((u) => u());
          taskUnsubs.set(id, cleanupRunSubs);

          runUnsubs.push(
            Bus.subscribe(Subagent.Events.WorkerRunCompleted, (data) => {
              if (data.payload.sessionId !== sessionId) return;
              cleanupRunSubs();
              taskUnsubs.delete(id);

              const current = tasks.get(id);
              if (!current || current.status === "cancelled") {
                activeCount--;
                drainQueue();
                return;
              }

              activeCount--;

              const completed: Subagent.BackgroundTask = {
                ...current,
                status: "completed",
                completedAt: Date.now(),
              };
              tasks.set(id, completed);

              let output: string | undefined;
              try {
                const msgs = Session.getMessages(sessionId);
                const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
                if (lastAssistant) {
                  const parts = Session.getParts(lastAssistant.id);
                  output =
                    parts
                      .filter((p): p is Message.TextPart => p.type === "text")
                      .map((p) => p.text)
                      .filter(Boolean)
                      .join("\n") || undefined;
                }
              } catch {
                // session may have been cleaned up
              }
              const result: Subagent.BackgroundTaskResult = {
                taskId: id,
                status: "completed",
                output,
              };
              results.set(id, result);
              BackgroundStore.persist(completed, output);
              onTaskComplete?.(result);
              Log.info("background.task.completed", { taskId: id, sessionId });

              Bus.publish(Subagent.Events.BackgroundTaskCompleted, {
                traceId: crypto.randomUUID(),
                time: Date.now(),
                payload: { taskId: id, status: "completed" as const, sessionId },
              });

              drainQueue();
            }),
          );

          runUnsubs.push(
            Bus.subscribe(Subagent.Events.WorkerRunFailed, (data) => {
              if (data.payload.sessionId !== sessionId) return;
              cleanupRunSubs();
              taskUnsubs.delete(id);

              const current = tasks.get(id);
              if (!current || current.status === "cancelled") {
                activeCount--;
                drainQueue();
                return;
              }

              activeCount--;

              const failed: Subagent.BackgroundTask = {
                ...current,
                status: "failed",
                completedAt: Date.now(),
                error: data.payload.error ?? "unknown error",
              };
              tasks.set(id, failed);
              BackgroundStore.persist(failed);

              const result: Subagent.BackgroundTaskResult = { taskId: id, status: "failed" };
              results.set(id, result);
              onTaskComplete?.(result);
              Log.info("background.task.failed", {
                taskId: id,
                sessionId,
                error: data.payload.error,
              });

              Bus.publish(Subagent.Events.BackgroundTaskFailed, {
                traceId: crypto.randomUUID(),
                time: Date.now(),
                payload: { taskId: id, error: data.payload.error ?? "unknown error" },
              });

              drainQueue();
            }),
          );

          Log.info("background.task.launched", {
            taskId: id,
            agentName: input.agentName,
            sessionId,
            runId,
          });
          Bus.publish(Subagent.Events.BackgroundTaskLaunched, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            payload: {
              taskId: id,
              agentName: input.agentName,
              parentSessionId: input.parentSessionId,
              status: "running" as const,
            },
          });
        },
        (err) => {
          controllers.delete(id);
          activeCount--;
          const failed: Subagent.BackgroundTask = {
            ...task,
            status: "failed",
            completedAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          };
          tasks.set(id, failed);
          BackgroundStore.persist(failed);
          Log.info("background.task.spawn-failed", {
            taskId: id,
            agentName: input.agentName,
            error: failed.error,
          });
          Bus.publish(Subagent.Events.BackgroundTaskFailed, {
            traceId: crypto.randomUUID(),
            time: Date.now(),
            payload: { taskId: id, error: failed.error },
          });

          drainQueue();
        },
      );
    }

    async function launch(input: LaunchInput): Promise<Subagent.BackgroundTask> {
      return withLaunchLock(async () => {
        const depth = input.depth ?? 0;
        const policy = await BackgroundLimitsMiddleware.evaluatePreLaunch({
          input: { ...input, depth },
          activeTasks: activeTasks(),
          activeCount,
          pendingQueueSize: pendingQueue.length,
          maxConcurrentPerAgent,
          maxConcurrentTotal,
          maxDepth,
          maxDescendants,
          maxQueueSize,
        });
        if (policy.verdict.action !== "continue") {
          return makeFailedTask(input, policy.verdict.reason ?? "background launch policy aborted");
        }

        const id = `bg_${crypto.randomUUID().slice(0, 8)}`;
        const task: Subagent.BackgroundTask = {
          id,
          agentName: input.agentName,
          prompt: input.prompt,
          status: "pending",
          parentSessionId: input.parentSessionId,
          queuedAt: Date.now(),
          depth,
        };
        tasks.set(id, task);

        if (policy.shouldQueue) {
          Log.info("background.task.queued", {
            taskId: id,
            agentName: input.agentName,
            depth,
            queueDepth: pendingQueue.length + 1,
          });
          pendingQueue.push({ input, id });
          return task;
        }

        activeCount++;
        await spawnTask(id, input, task);
        return tasks.get(id) ?? task;
      });
    }

    async function cancel(taskId: string): Promise<boolean> {
      const task = tasks.get(taskId);
      if (!task) return false;
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
        return false;

      const queueIdx = pendingQueue.findIndex((item) => item.id === taskId);
      if (queueIdx !== -1) {
        pendingQueue.splice(queueIdx, 1);
      }

      controllers.get(taskId)?.abort();
      taskUnsubs.get(taskId)?.();
      taskUnsubs.delete(taskId);
      const cancelled: Subagent.BackgroundTask = {
        ...task,
        status: "cancelled",
        completedAt: Date.now(),
      };
      tasks.set(taskId, cancelled);
      BackgroundStore.persist(cancelled);

      Bus.publish(Subagent.Events.BackgroundTaskCancelled, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        payload: { taskId },
      });

      return true;
    }

    return {
      launch,
      getTask: (taskId) => tasks.get(taskId) ?? BackgroundStore.getTask(taskId),
      getResult: (taskId) => results.get(taskId) ?? BackgroundStore.getResult(taskId),
      cancel,
      listByParent: (parentSessionId) =>
        [...tasks.values()].filter((t) => t.parentSessionId === parentSessionId),
      cleanup,
      stats: () => ({
        active: activeCount,
        pending: pendingQueue.length,
        total: tasks.size,
      }),
      dispose: () => {
        clearInterval(cleanupInterval);
        stopSweep();
      },
    };
  },
};
