import { Task, TaskRun, TriggerSignal } from "./types";
import { TaskStorage, TaskListFilter, InMemoryTaskStore } from "./storage";
import { Bus } from "@openomni/session";
import { Task as TaskEvent } from "@openomni/protocol";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

// ============================================================
// Types
// ============================================================

export type TriggerError =
  | "rate_limited"
  | "deduped"
  | "concurrency_blocked"
  | "denied"
  | "not_found";

export type TriggerResult = { runId: string } | { error: TriggerError };

// ============================================================
// Simple Mutex for concurrent trigger safety
// ============================================================

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

// Per-task mutexes
const taskMutexes = new Map<string, SimpleMutex>();

function getTaskMutex(taskId: string): SimpleMutex {
  let mutex = taskMutexes.get(taskId);
  if (!mutex) {
    mutex = new SimpleMutex();
    taskMutexes.set(taskId, mutex);
  }
  return mutex;
}

// ============================================================
// Rate limit tracking (in-memory, per task)
// ============================================================

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitTracking = new Map<string, RateLimitEntry>();

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

function generateIdempotencyKey(taskId: string, signal: TriggerSignal): string {
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
            .update(JSON.stringify(payload))
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
  store: InMemoryTaskStore,
  idempotencyKey: string,
  dedupeWindowMs: number | undefined,
  now: number,
): TaskRun | undefined {
  if (!dedupeWindowMs) return undefined;

  const existingRun = store.getByIdempotencyKey(idempotencyKey);
  if (!existingRun) return undefined;

  const isWithinWindow = now - existingRun.scheduledAt < dedupeWindowMs;
  return isWithinWindow ? existingRun : undefined;
}

function checkConcurrency(
  store: TaskStore,
  taskId: string,
  _task: Task.Info,
  concurrency: Task.Concurrency | undefined,
): { allowed: boolean; pendingRun?: TaskRun } {
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

type TaskStore = ReturnType<typeof TaskStorage.getAdapter>;

export namespace TaskManager {
  export function create(input: Task.CreateInput): Task.Info {
    const validated = Task.CreateInput.parse(input);

    const id = randomUUID();
    const now = Date.now();

    const task: Task.Info = {
      id,
      title: validated.title,
      description: validated.description,
      owner: validated.owner,
      assignedAgentId: validated.assignedAgentId,
      agentGraphId: validated.agentGraphId,
      status: "idle",
      triggers: validated.triggers ?? [],
      policy: validated.policy ?? {},
      createdAt: now,
      updatedAt: now,
      tags: validated.tags,
      metadata: validated.metadata,
    };

    const store = TaskStorage.getAdapter();
    store.task.set(id, task);

    Bus.publish(TaskEvent.Created, {
      traceId: randomUUID(),
      taskId: id,
      time: now,
      payload: {
        id,
        name: task.title,
        description: task.description,
        status: task.status,
      },
    });

    return task;
  }

  export function update(
    id: string,
    input: Task.UpdateInput,
  ): Task.Info | undefined {
    const validated = Task.UpdateInput.parse(input);

    const store = TaskStorage.getAdapter();
    const existing = store.task.get(id);
    if (!existing) {
      return undefined;
    }

    const now = Date.now();
    const updated: Task.Info = {
      ...existing,
      ...validated,
      id,
      updatedAt: now,
    };

    store.task.set(id, updated);

    Bus.publish(TaskEvent.Updated, {
      traceId: randomUUID(),
      taskId: id,
      time: now,
      payload: {
        id,
        changes: validated,
      },
    });

    return updated;
  }

  export function remove(id: string): boolean {
    const store = TaskStorage.getAdapter();
    const existing = store.task.get(id);
    if (!existing) {
      return false;
    }

    const removed = store.task.remove(id);

    if (removed) {
      const now = Date.now();
      Bus.publish(TaskEvent.Deleted, {
        traceId: randomUUID(),
        taskId: id,
        time: now,
        payload: {
          id,
        },
      });
    }

    return removed;
  }

  export function get(id: string): Task.Info | undefined {
    const store = TaskStorage.getAdapter();
    return store.task.get(id);
  }

  export function list(filter?: {
    owner?: Task.Owner;
    status?: Task.Status;
    tag?: string;
    hasTriggersOfType?: Task.Trigger["type"];
  }): Task.Info[] {
    const store = TaskStorage.getAdapter();

    const storeFilter: TaskListFilter | undefined = filter
      ? {
          ownerId: filter.owner?.id,
          status: filter.status,
          tags: filter.tag ? [filter.tag] : undefined,
        }
      : undefined;

    let tasks = store.task.list(storeFilter);

    if (filter?.hasTriggersOfType) {
      const triggerType = filter.hasTriggersOfType;
      tasks = tasks.filter((task) =>
        task.triggers.some((trigger) => trigger.type === triggerType),
      );
    }

    return tasks;
  }

  export async function trigger(
    taskId: string,
    signal: TriggerSignal,
  ): Promise<TriggerResult> {
    const mutex = getTaskMutex(taskId);
    await mutex.acquire();

    try {
      const store = TaskStorage.getAdapter();
      const task = store.task.get(taskId);

      if (!task) {
        return { error: "not_found" };
      }

      const now = Date.now();
      const policy = task.policy;

      if (!checkRateLimit(taskId, policy.rateLimit, now)) {
        return { error: "rate_limited" };
      }

      const idempotencyKey = generateIdempotencyKey(taskId, signal);

      if (
        "getByIdempotencyKey" in store &&
        typeof store.getByIdempotencyKey === "function"
      ) {
        const memStore = store as InMemoryTaskStore;
        const deduped = checkDedupe(
          memStore,
          idempotencyKey,
          policy.dedupe?.windowMs,
          now,
        );
        if (deduped) {
          return { error: "deduped" };
        }
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
      const status: TaskRun["status"] =
        permission === "ask" ? "blocked" : "scheduled";

      const taskRun: TaskRun = {
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
      };

      store.run.set(taskId, taskRun);

      const updatedTask: Task.Info = {
        ...task,
        status: status,
        pendingRun: taskRun,
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

  // ============================================================
  // Run Management APIs
  // ============================================================

  /**
   * Get a single run by ID
   */
  export function getRun(runId: string): TaskRun | undefined {
    const store = TaskStorage.getAdapter();
    return store.run.get(runId);
  }

  /**
   * List runs for a specific task with pagination and filtering
   */
  export function listRuns(
    taskId: string,
    opts?: { status?: TaskRun["status"]; limit?: number; offset?: number },
  ): TaskRun[] {
    const store = TaskStorage.getAdapter();
    let runs = store.run.list(taskId, {
      limit: opts?.limit,
      offset: opts?.offset,
    });

    if (opts?.status) {
      runs = runs.filter((r) => r.status === opts.status);
    }

    return runs;
  }

  /**
   * List runs across all tasks by status (for crash recovery, monitoring)
   */
  export function listRunsByStatus(
    status: TaskRun["status"] | TaskRun["status"][],
    opts?: { limit?: number; offset?: number },
  ): TaskRun[] {
    const store = TaskStorage.getAdapter();
    const statuses = Array.isArray(status) ? status : [status];
    let runs = store.run.listByStatus(statuses);

    if (opts?.offset !== undefined || opts?.limit !== undefined) {
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? runs.length;
      runs = runs.slice(offset, offset + limit);
    }

    return runs;
  }

  /**
   * Update a run's status directly (internal use: crash recovery, orchestration)
   */
  export function setRunStatus(
    runId: string,
    newStatus: TaskRun["status"],
    reason?: string,
  ): boolean {
    const store = TaskStorage.getAdapter();
    const run = store.run.get(runId);

    if (!run) {
      return false;
    }

    const now = Date.now();
    const updatedRun: TaskRun = {
      ...run,
      status: newStatus,
    };

    if (newStatus === "running" && !run.startedAt) {
      updatedRun.startedAt = now;
    }

    if (
      (newStatus === "done" ||
        newStatus === "failed" ||
        newStatus === "cancelled") &&
      !run.endedAt
    ) {
      updatedRun.endedAt = now;
    }

    store.run.set(run.taskId, updatedRun);

    const task = store.task.get(run.taskId);
    if (task) {
      const updatedTask: Task.Info = {
        ...task,
        status: newStatus,
        updatedAt: now,
      };
      store.task.set(run.taskId, updatedTask);

      if (newStatus === "cancelled") {
        Bus.publish(TaskEvent.RunCancelled, {
          traceId: randomUUID(),
          taskId: run.taskId,
          time: now,
          payload: {
            id: runId,
            taskId: run.taskId,
            reason: reason ?? "status_update",
          },
        });
      }
    }

    return true;
  }

  /**
   * Cancel a running/scheduled/blocked run
   */
  export function cancelRun(runId: string, reason?: string): boolean {
    const store = TaskStorage.getAdapter();
    const run = store.run.get(runId);

    if (!run) {
      return false;
    }

    // Can only cancel if in cancellable state
    const cancellableStatuses: TaskRun["status"][] = [
      "scheduled",
      "running",
      "blocked",
    ];
    if (!cancellableStatuses.includes(run.status)) {
      return false;
    }

    return setRunStatus(runId, "cancelled", reason);
  }

  /**
   * Resume a blocked run after approval
   */
  export function resumeRun(
    runId: string,
    approvalContext?: {
      approvedBy: string;
      approvalType: "once" | "always";
    },
  ): boolean {
    const store = TaskStorage.getAdapter();
    const run = store.run.get(runId);

    if (!run) {
      return false;
    }

    // Can only resume if blocked
    if (run.status !== "blocked") {
      return false;
    }

    // Transition to scheduled (ready to run)
    return setRunStatus(
      runId,
      "scheduled",
      approvalContext
        ? `approved_by:${approvalContext.approvedBy}:${approvalContext.approvalType}`
        : "resumed",
    );
  }

  /**
   * List blocked runs awaiting approval (for crash recovery)
   */
  export function listBlockedRuns(filter?: {
    taskId?: string;
    userId?: string;
  }): TaskRun[] {
    const store = TaskStorage.getAdapter();
    let blockedRuns = store.run.listByStatus(["blocked"]);

    if (filter?.taskId) {
      blockedRuns = blockedRuns.filter((r) => r.taskId === filter.taskId);
    }

    if (filter?.userId) {
      blockedRuns = blockedRuns.filter(
        (r) => r.context?.userId === filter.userId,
      );
    }

    return blockedRuns;
  }
}
