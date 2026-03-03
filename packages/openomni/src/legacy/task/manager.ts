// TaskManager: ~500 LOC — tightly coupled task lifecycle orchestrator.
// Manages creation, triggering, state transitions, and run coordination
// as a single cohesive unit. Splitting would thread shared task state
// through multiple function parameters (see modular-code-architecture Rule 5).

import { Task } from "./types";
import { TaskStorage, TaskListFilter } from "./storage";
import { TaskStatusManager } from "./lifecycle";
import { triggerTask } from "./trigger-engine";
import type { TriggerResult } from "./trigger-engine";
export type { TriggerError, TriggerResult } from "./trigger-engine";
import { Bus } from "@openomni/session";
import { Task as TaskEvent } from "@openomni/protocol";
import { randomUUID } from "crypto";

/**
 * PolicyError — policy violation errors for task execution hardening
 *
 * Used to identify and handle policy violations in task execution:
 * - D6_task_from_task: trigger_task blocked in task context
 * - D6_task_creation: TaskManager.create blocked in task context
 * - anti_loop_self_retrigger: Completion event self-retrigger blocked
 */
export class PolicyError extends Error {
  public readonly name = "PolicyError" as const;

  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

function isActiveRunStatus(status: Task.Run["status"]): boolean {
  return status === "scheduled" || status === "running" || status === "blocked";
}

function upsertRunHistory(
  history: Task.Run[] | undefined,
  run: Task.Run,
): Task.Run[] {
  if (!history || history.length === 0) {
    return [run];
  }

  const index = history.findIndex((item) => item.runId === run.runId);
  if (index === -1) {
    return [...history, run];
  }

  const updated = [...history];
  updated[index] = run;
  return updated;
}

export namespace TaskManager {
  export function create(
    input: Task.CreateInput,
    context?: {
      executionContext?: "top_level" | "task";
      intent?: "durable" | "run_tracking";
    },
  ): Task.Info {
    const validated = Task.CreateInput.parse(input);

    // D6: Block durable task creation in task context
    if (context?.executionContext === "task" && context?.intent === "durable") {
      throw new PolicyError(
        "D6_task_creation",
        "Cannot create durable task from task execution context",
      );
    }

    const id = randomUUID();
    const now = Date.now();

    const task: Task.Info = {
      id,
      title: validated.title,
      description: validated.description,
      owner: validated.owner,
      assignedAgentId: validated.assignedAgentId,
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
    signal: Task.TriggerSignal,
  ): Promise<TriggerResult> {
    return triggerTask(taskId, signal);
  }

  // ============================================================
  // Run Management APIs
  // ============================================================

  /**
   * Get a single run by ID
   */
  export function getRun(runId: string): Task.Run | undefined {
    const store = TaskStorage.getAdapter();
    return store.run.get(runId);
  }

  /**
   * List runs for a specific task with pagination and filtering
   */
  export function listRuns(
    taskId: string,
    opts?: { status?: Task.Run["status"]; limit?: number; offset?: number },
  ): Task.Run[] {
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
    status: Task.Run["status"] | Task.Run["status"][],
    opts?: { limit?: number; offset?: number },
  ): Task.Run[] {
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
    newStatus: Task.Run["status"],
    reason?: string,
  ): boolean {
    const store = TaskStorage.getAdapter();
    const run = store.run.get(runId);

    if (!run) {
      return false;
    }

    const now = Date.now();
    const updatedRun: Task.Run = {
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
      const pendingRun =
        task.pendingRun?.runId === runId
          ? isActiveRunStatus(updatedRun.status)
            ? updatedRun
            : undefined
          : task.pendingRun;

      const lastRun = isActiveRunStatus(updatedRun.status)
        ? task.lastRun
        : updatedRun;

      const statusUpdated = TaskStatusManager.updateFromRun(
        task,
        pendingRun,
        lastRun,
      );

      const updatedTask: Task.Info = {
        ...statusUpdated,
        history: isActiveRunStatus(updatedRun.status)
          ? task.history
          : upsertRunHistory(task.history, updatedRun),
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
    const cancellableStatuses: Task.Run["status"][] = [
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

    // Persist "always approve" to task policy
    if (approvalContext?.approvalType === "always") {
      const task = store.task.get(run.taskId);
      if (task) {
        const updatedTask: Task.Info = {
          ...task,
          policy: {
            ...task.policy,
            permission: "notify",
          },
        };
        store.task.set(run.taskId, updatedTask);
      }
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
  }): Task.Run[] {
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

  /**
   * Save checkpoint progress for a run
   */
  export function saveCheckpoint(
    runId: string,
    checkpoint: {
      step: string;
      data: Record<string, unknown>;
    },
  ): boolean {
    const store = TaskStorage.getAdapter();
    const run = store.run.get(runId);
    if (!run) {
      return false;
    }

    const updatedRun: Task.Run = {
      ...run,
      checkpoint: {
        step: checkpoint.step,
        data: checkpoint.data,
        savedAt: Date.now(),
      },
    };

    store.run.set(run.taskId, updatedRun);
    return true;
  }

  /**
   * Get the lineage (parent chain) for a run.
   * Returns an array of ancestor Task.Run objects from immediate parent to root.
   * Empty array if the run has no spawnedBy (root task).
   */
  export function getLineage(runId: string): Task.Run[] {
    const store = TaskStorage.getAdapter();
    const lineage: Task.Run[] = [];
    const visited = new Set<string>();

    let currentRunId: string | undefined = runId;

    while (currentRunId) {
      if (visited.has(currentRunId)) {
        break;
      }
      visited.add(currentRunId);

      const run = store.run.get(currentRunId);
      if (!run || !run.spawnedBy) {
        break;
      }

      const parentRunId = run.spawnedBy.runId;
      if (visited.has(parentRunId)) {
        break;
      }

      const parentRun = store.run.get(parentRunId);
      if (!parentRun) {
        break;
      }

      lineage.push(parentRun);
      currentRunId = parentRunId;
    }

    return lineage;
  }
}
