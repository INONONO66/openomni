import { type Message, Subagent } from "@openomni/protocol";
import { Bus, Session } from "@openomni/session";
import { BackgroundStore } from "./background-store.js";
import {
  publishBackgroundTaskCompleted,
  publishBackgroundTaskFailed,
  publishBackgroundTaskLaunched,
} from "./background-manager-events.js";
import type { BackgroundQueue } from "./background-manager-queue.js";
import type { BackgroundManagerState } from "./background-manager-state.js";
import type {
  BackgroundLaunchInput,
  ResolvedBackgroundManagerConfig,
} from "./background-manager-types.js";
import { SubagentRuntime } from "./runtime.js";

export type BackgroundRunner = {
  spawnTask(taskId: string, input: BackgroundLaunchInput): Promise<void>;
};

export function createBackgroundRunner(input: {
  readonly config: ResolvedBackgroundManagerConfig;
  readonly state: BackgroundManagerState;
  readonly queue: BackgroundQueue;
  readonly drainQueue: () => void;
}): BackgroundRunner {
  const { config, state, queue, drainQueue } = input;

  function finishCancelledOrMissing(taskId: string): void {
    state.controllers.delete(taskId);
    queue.releaseActive(taskId);
    drainQueue();
  }

  function setTaskUnsub(taskId: string, unsubs: readonly (() => void)[]): void {
    const cleanupRunSubs = () => unsubs.forEach((unsubscribe) => unsubscribe());
    state.taskUnsubs.set(taskId, cleanupRunSubs);
  }

  function completeTask(taskId: string, sessionId: string): void {
    const current = state.tasks.get(taskId);
    if (current === undefined || current.status === "cancelled") {
      finishCancelledOrMissing(taskId);
      return;
    }

    state.controllers.delete(taskId);
    queue.releaseActive(taskId);

    const completed: Subagent.BackgroundTask = {
      ...current,
      status: "completed",
      completedAt: Date.now(),
    };
    state.tasks.set(taskId, completed);

    const output = extractAssistantOutput(sessionId);
    const result: Subagent.BackgroundTaskResult = {
      taskId,
      status: "completed",
      output,
    };
    state.results.set(taskId, result);
    BackgroundStore.persist(completed, output);
    config.onTaskComplete?.(result);

    publishBackgroundTaskCompleted({ taskId, sessionId });
    drainQueue();
  }

  function failTask(taskId: string, error: string): void {
    const current = state.tasks.get(taskId);
    if (current === undefined || current.status === "cancelled") {
      finishCancelledOrMissing(taskId);
      return;
    }

    state.controllers.delete(taskId);
    queue.releaseActive(taskId);

    const failed: Subagent.BackgroundTask = {
      ...current,
      status: "failed",
      completedAt: Date.now(),
      error,
    };
    state.tasks.set(taskId, failed);
    BackgroundStore.persist(failed);

    const result: Subagent.BackgroundTaskResult = { taskId, status: "failed" };
    state.results.set(taskId, result);
    config.onTaskComplete?.(result);

    publishBackgroundTaskFailed({ taskId, error });
    drainQueue();
  }

  function subscribeRunSettlement(taskId: string, sessionId: string, runId: string): void {
    const runUnsubs: Array<() => void> = [];
    const cleanupRunSubs = () => {
      runUnsubs.forEach((unsubscribe) => unsubscribe());
      state.taskUnsubs.delete(taskId);
    };

    runUnsubs.push(
      Bus.subscribe(Subagent.Events.WorkerRunCompleted, (data) => {
        if (data.payload.sessionId !== sessionId || data.payload.runId !== runId) return;
        cleanupRunSubs();
        completeTask(taskId, sessionId);
      }),
    );

    runUnsubs.push(
      Bus.subscribe(Subagent.Events.WorkerRunFailed, (data) => {
        if (data.payload.sessionId !== sessionId || data.payload.runId !== runId) return;
        cleanupRunSubs();
        failTask(taskId, data.payload.error ?? "unknown error");
      }),
    );

    setTaskUnsub(taskId, runUnsubs);
  }

  return {
    spawnTask(taskId, launchInput) {
      const controller = new AbortController();
      state.controllers.set(taskId, controller);

      return Promise.resolve()
        .then(() =>
          SubagentRuntime.spawnBackground({
            agentName: launchInput.agentName,
            prompt: launchInput.prompt,
            title: launchInput.prompt.slice(0, 50),
            model: launchInput.model,
            auth: config.resolveAuth?.(launchInput.model.provider),
            allowAuthFallback: config.allowAuthFallback,
            permissions: launchInput.permissions,
            systemPrompt: launchInput.systemPrompt,
            tools: launchInput.tools,
            toolExecutor: launchInput.toolExecutor,
            middleware: launchInput.middleware,
            childMiddleware: launchInput.childMiddleware,
            signal: controller.signal,
          }),
        )
        .then(
          async ({ sessionId, runId }) => {
            const currentTask = state.tasks.get(taskId);
            if (currentTask === undefined || currentTask.status === "cancelled") {
              await SubagentRuntime.cancel({ sessionId, runId }).catch(() => undefined);
              finishCancelledOrMissing(taskId);
              return;
            }

            const running: Subagent.BackgroundTask = {
              ...currentTask,
              status: "running",
              sessionId,
              runId,
              startedAt: Date.now(),
            };
            state.tasks.set(taskId, running);
            BackgroundStore.persist(running);

            subscribeRunSettlement(taskId, sessionId, runId);
            publishBackgroundTaskLaunched({
              taskId,
              agentName: launchInput.agentName,
              parentSessionId: launchInput.parentSessionId,
            });
          },
          (error) => {
            state.controllers.delete(taskId);
            queue.releaseActive(taskId);

            const current = state.tasks.get(taskId);
            if (current === undefined || current.status === "cancelled") {
              drainQueue();
              return;
            }

            const failed: Subagent.BackgroundTask = {
              ...current,
              status: "failed",
              completedAt: Date.now(),
              error: error instanceof Error ? error.message : String(error),
            };
            state.tasks.set(taskId, failed);
            BackgroundStore.persist(failed);
            publishBackgroundTaskFailed({ taskId, error: failed.error });

            drainQueue();
          },
        );
    },
  };
}

function extractAssistantOutput(sessionId: string): string | undefined {
  try {
    const messages = Session.getMessages(sessionId);
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant === undefined) return undefined;

    const parts = Session.getParts(lastAssistant.id);
    return (
      parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .filter(Boolean)
        .join("\n") || undefined
    );
  } catch {
    return undefined;
  }
}
