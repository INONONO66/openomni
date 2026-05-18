import {
  type Message,
  type Model,
  PolicyDecision,
  type Policy,
  Subagent,
  type RuntimeResource,
} from "@openomni/protocol";
import { Bus, Session } from "@openomni/session";
import { startSweep, stopSweep } from "./abort-registry";
import { BackgroundStore } from "./background-store.js";
import { BackgroundLimitsMiddleware } from "./middleware/background-limits.js";
import { SubagentRuntime } from "./runtime.js";
import type { RuntimeConfig } from "./transcript.js";

type LaunchInput = {
  agentName: string;
  prompt: string;
  model: Model.Ref;
  parentSessionId: string;
  depth?: number;
  permissions?: Policy.Permission;
  systemPrompt?: RuntimeConfig["systemPrompt"];
  tools?: RuntimeConfig["tools"];
  toolExecutor?: RuntimeConfig["toolExecutor"];
  middleware?: RuntimeConfig["middleware"];
  childMiddleware?: RuntimeConfig["childMiddleware"];
};

type Config = {
  maxConcurrentPerAgent?: number;
  maxConcurrentTotal?: number;
  maxDepth?: number;
  maxDescendants?: number;
  taskTtlMs?: number;
  maxQueueSize?: number;
  resolveAuth?: (provider: string) => RuntimeConfig["auth"];
  allowAuthFallback?: RuntimeConfig["allowAuthFallback"];
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

function createBackgroundLaunchDescriptor(agentName: string): RuntimeResource.Descriptor {
  return {
    id: "worker:agent:background_launch",
    kind: "worker",
    source: { type: "agent", agentId: agentName },
    labels: ["source.agent", "delegation.background"],
    capabilities: ["delegation.background"],
    effects: ["session.create"],
  };
}

function backgroundLaunchFailureReason(decision: Policy.PolicyDecision): string | undefined {
  if (!PolicyDecision.isBlocking(decision)) return undefined;
  return PolicyDecision.reason(decision, `background launch policy returned ${decision.verdict}`);
}

export const BackgroundManager = {
  create(config?: Config): BackgroundManagerInstance {
    const maxConcurrentPerAgent = config?.maxConcurrentPerAgent ?? 3;
    const maxConcurrentTotal = config?.maxConcurrentTotal ?? 10;
    const maxDepth = config?.maxDepth ?? 5;
    const maxDescendants = config?.maxDescendants ?? 10;
    const taskTtlMs = config?.taskTtlMs ?? 1_800_000;
    const maxQueueSize = config?.maxQueueSize ?? 100;
    const resolveAuth = config?.resolveAuth;
    const allowAuthFallback = config?.allowAuthFallback;
    const onTaskComplete = config?.onTaskComplete;

    const tasks = new Map<string, Subagent.BackgroundTask>();
    const results = new Map<string, Subagent.BackgroundTaskResult>();
    const controllers = new Map<string, AbortController>();
    const taskUnsubs = new Map<string, () => void>();

    type QueuedItem = { input: LaunchInput; id: string };
    const pendingQueue: QueuedItem[] = [];
    // Tracks spawning + running tasks synchronously before async spawn completes.
    let activeCount = 0;
    const activeTaskIds = new Set<string>();
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

        markActive(next.id);
        spawnTask(next.id, next.input);
      }
    }

    function markActive(taskId: string): void {
      if (activeTaskIds.has(taskId)) return;
      activeTaskIds.add(taskId);
      activeCount++;
    }

    function releaseActive(taskId: string): void {
      if (!activeTaskIds.delete(taskId)) return;
      activeCount--;
    }

    function spawnTask(id: string, input: LaunchInput): Promise<void> {
      const controller = new AbortController();
      controllers.set(id, controller);

      return Promise.resolve()
        .then(() =>
          SubagentRuntime.spawnBackground({
            agentName: input.agentName,
            prompt: input.prompt,
            title: input.prompt.slice(0, 50),
            model: input.model,
            auth: resolveAuth?.(input.model.provider),
            allowAuthFallback,
            permissions: input.permissions,
            systemPrompt: input.systemPrompt,
            tools: input.tools,
            toolExecutor: input.toolExecutor,
            middleware: input.middleware,
            childMiddleware: input.childMiddleware,
            signal: controller.signal,
          }),
        )
        .then(
          async ({ sessionId, runId }) => {
            const currentTask = tasks.get(id);
            if (!currentTask || currentTask.status === "cancelled") {
              try {
                await SubagentRuntime.cancel({ sessionId, runId });
              } catch {
                // The run may already be terminal; local background accounting still needs cleanup.
              }
              controllers.delete(id);
              releaseActive(id);
              drainQueue();
              return;
            }

            const running: Subagent.BackgroundTask = {
              ...currentTask,
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
                if (data.payload.sessionId !== sessionId || data.payload.runId !== runId) return;
                cleanupRunSubs();
                taskUnsubs.delete(id);

                const current = tasks.get(id);
                if (!current || current.status === "cancelled") {
                  controllers.delete(id);
                  releaseActive(id);
                  drainQueue();
                  return;
                }

                controllers.delete(id);
                releaseActive(id);

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
                if (data.payload.sessionId !== sessionId || data.payload.runId !== runId) return;
                cleanupRunSubs();
                taskUnsubs.delete(id);

                const current = tasks.get(id);
                if (!current || current.status === "cancelled") {
                  controllers.delete(id);
                  releaseActive(id);
                  drainQueue();
                  return;
                }

                controllers.delete(id);
                releaseActive(id);

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

                Bus.publish(Subagent.Events.BackgroundTaskFailed, {
                  traceId: crypto.randomUUID(),
                  time: Date.now(),
                  payload: { taskId: id, error: data.payload.error ?? "unknown error" },
                });

                drainQueue();
              }),
            );

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
            releaseActive(id);

            const current = tasks.get(id);
            if (!current || current.status === "cancelled") {
              drainQueue();
              return;
            }

            const failed: Subagent.BackgroundTask = {
              ...current,
              status: "failed",
              completedAt: Date.now(),
              error: err instanceof Error ? err.message : String(err),
            };
            tasks.set(id, failed);
            BackgroundStore.persist(failed);
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
        const resourceDescriptor = createBackgroundLaunchDescriptor(input.agentName);
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
          resourceDescriptor,
        });
        const launchFailureReason = backgroundLaunchFailureReason(policy.verdict);
        if (launchFailureReason !== undefined) {
          return makeFailedTask(input, launchFailureReason);
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
          pendingQueue.push({ input, id });
          drainQueue();
          return tasks.get(id) ?? task;
        }

        markActive(id);
        await spawnTask(id, input);
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
      controllers.delete(taskId);
      const cancelled: Subagent.BackgroundTask = {
        ...task,
        status: "cancelled",
        completedAt: Date.now(),
      };
      tasks.set(taskId, cancelled);
      BackgroundStore.persist(cancelled);
      releaseActive(taskId);

      Bus.publish(Subagent.Events.BackgroundTaskCancelled, {
        traceId: crypto.randomUUID(),
        time: Date.now(),
        payload: { taskId },
      });

      drainQueue();

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
