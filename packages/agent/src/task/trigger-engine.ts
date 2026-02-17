import { randomUUID, createHash } from "crypto";
import { Bus } from "@openomni/session";
import { Task as TaskEvent } from "@openomni/protocol";
import { Task } from "./types";
import { TaskStorage } from "./storage";
import { TaskStatusManager } from "./lifecycle";

export type TriggerError =
  | "rate_limited"
  | "deduped"
  | "filtered"
  | "concurrency_blocked"
  | "denied"
  | "not_found";

export type TriggerResult = { runId: string } | { error: TriggerError };

class SimpleMutex {
  private locked = false;
  private queue: (() => void)[] = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

const taskMutexes = new Map<string, SimpleMutex>();

function getTaskMutex(taskId: string): SimpleMutex {
  let mutex = taskMutexes.get(taskId);
  if (!mutex) {
    mutex = new SimpleMutex();
    taskMutexes.set(taskId, mutex);
  }
  return mutex;
}

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitTracking = new Map<string, RateLimitEntry>();

type TaskStore = ReturnType<typeof TaskStorage.getAdapter>;

function checkRateLimit(
  taskId: string,
  rateLimit: Task.RateLimit | undefined,
  now: number,
): boolean {
  if (!rateLimit) return true;

  const entry = rateLimitTracking.get(taskId) ?? { timestamps: [] };
  const windowStart = now - rateLimit.windowMs;

  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

  return entry.timestamps.length < rateLimit.maxPerWindow;
}

function recordRateLimitHit(taskId: string, now: number): void {
  const entry = rateLimitTracking.get(taskId) ?? { timestamps: [] };
  entry.timestamps.push(now);
  rateLimitTracking.set(taskId, entry);
}

function generateIdempotencyKey(
  taskId: string,
  signal: Task.TriggerSignal,
): string {
  const { triggerId, type, payload, occurredAt } = signal;

  switch (type) {
    case "cron": {
      const iso = new Date(occurredAt).toISOString();
      return `${taskId}:${triggerId}:${iso}`;
    }
    case "interval": {
      const tick = Math.floor(occurredAt / 1000);
      return `${taskId}:${triggerId}:tick-${tick}`;
    }
    case "once":
      return `${taskId}:${triggerId}:${occurredAt}`;
    case "event": {
      const naturalKey = payload
        ? createHash("sha256")
            .update(
              JSON.stringify(
                typeof payload === "object" &&
                  payload !== null &&
                  !Array.isArray(payload)
                  ? Object.keys(payload)
                      .sort()
                      .reduce(
                        (acc, key) => {
                          acc[key] = (payload as Record<string, unknown>)[key];
                          return acc;
                        },
                        {} as Record<string, unknown>,
                      )
                  : payload,
              ),
            )
            .digest("hex")
            .slice(0, 16)
        : "no-payload";
      return `${taskId}:${triggerId}:${naturalKey}`;
    }
    case "manual":
      return `${taskId}:manual:${occurredAt}`;
    default:
      return `${taskId}:${triggerId}:${occurredAt}`;
  }
}

function checkDedupe(
  store: TaskStore,
  idempotencyKey: string,
  dedupeWindowMs: number | undefined,
  now: number,
): Task.Run | undefined {
  if (!dedupeWindowMs) return undefined;

  const existingRun = store.run.getByIdempotencyKey(idempotencyKey);
  if (!existingRun) return undefined;

  const isWithinWindow = now - existingRun.scheduledAt < dedupeWindowMs;
  return isWithinWindow ? existingRun : undefined;
}

function checkConcurrency(
  store: TaskStore,
  taskId: string,
  _task: Task.Info,
  concurrency: Task.Concurrency | undefined,
): { allowed: boolean; pendingRun?: Task.Run } {
  const maxRunning = concurrency?.maxRunning ?? 1;
  const mode = concurrency?.mode ?? "drop";

  const runs = store.run.list(taskId);
  const activeRuns = runs.filter(
    (r) => r.status === "running" || r.status === "blocked",
  );
  const scheduledRuns = runs.filter((r) => r.status === "scheduled");

  if (activeRuns.length >= maxRunning) {
    if (mode === "queue") {
      if (scheduledRuns.length > 0) {
        return { allowed: false, pendingRun: scheduledRuns[0] };
      }
      return { allowed: true };
    }
    return { allowed: false };
  }

  return { allowed: true };
}

export async function triggerTask(
  taskId: string,
  signal: Task.TriggerSignal,
): Promise<TriggerResult> {
  const mutex = getTaskMutex(taskId);
  await mutex.acquire();

  try {
    const store = TaskStorage.getAdapter();
    const task = store.task.get(taskId);

    if (!task) {
      return { error: "not_found" };
    }

    if (
      signal.context?.originTaskId &&
      signal.context.originTaskId === taskId
    ) {
      console.warn(
        `[anti-loop] self-retrigger blocked in TaskManager.trigger: originTaskId=${signal.context.originTaskId}, taskId=${taskId}`,
      );
      return { error: "denied" };
    }

    const now = Date.now();
    const policy = task.policy;

    if (!checkRateLimit(taskId, policy.rateLimit, now)) {
      return { error: "rate_limited" };
    }

    const idempotencyKey = generateIdempotencyKey(taskId, signal);

    const deduped = checkDedupe(
      store,
      idempotencyKey,
      policy.dedupe?.windowMs,
      now,
    );
    if (deduped) {
      return { error: "deduped" };
    }

    const concurrencyResult = checkConcurrency(
      store,
      taskId,
      task,
      policy.concurrency,
    );
    if (!concurrencyResult.allowed) {
      return { error: "concurrency_blocked" };
    }

    const permission = policy.permission ?? "notify";
    if (permission === "deny") {
      return { error: "denied" };
    }

    recordRateLimitHit(taskId, now);

    const runId = randomUUID();
    const sessionKey = `task:${taskId}:run:${runId}`;
    const status: Task.Run["status"] =
      permission === "ask" ? "blocked" : "scheduled";

    const taskRun: Task.Run = {
      runId,
      taskId,
      sessionKey,
      status,
      trigger: {
        id: signal.triggerId,
        type: signal.type,
      },
      idempotencyKey,
      payload: signal.payload,
      context: signal.context,
      attempt: 1,
      agentId: task.assignedAgentId,
      scheduledAt: now,
      spawnedBy: signal.spawnedBy,
    };

    store.run.set(taskId, taskRun);

    const statusUpdated = TaskStatusManager.updateFromRun(
      task,
      taskRun,
      task.lastRun,
    );
    const updatedTask: Task.Info = {
      ...statusUpdated,
      updatedAt: now,
    };
    store.task.set(taskId, updatedTask);

    if (status === "scheduled") {
      Bus.publish(TaskEvent.RunScheduled, {
        traceId: signal.context?.traceId ?? randomUUID(),
        taskId,
        time: now,
        payload: {
          id: runId,
          taskId,
          scheduledTime: now,
        },
      });
    } else {
      Bus.publish(TaskEvent.RunBlocked, {
        traceId: signal.context?.traceId ?? randomUUID(),
        taskId,
        time: now,
        payload: {
          id: runId,
          taskId,
          reason: "awaiting_approval",
        },
      });
    }

    return { runId };
  } finally {
    mutex.release();
  }
}
