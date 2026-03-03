import { describe, expect, test } from "bun:test";
import {
  TaskStateMachine,
  TaskStatusManager,
} from "../../../src/legacy/task/lifecycle/state-machine";
import type { Task } from "../../../src/legacy/task/types";

describe("TaskStateMachine", () => {
  describe("validateTransition", () => {
    test("idle -> scheduled is valid", () => {
      expect(TaskStateMachine.validateTransition("idle", "scheduled")).toBe(
        true,
      );
    });

    test("scheduled -> running is valid", () => {
      expect(TaskStateMachine.validateTransition("scheduled", "running")).toBe(
        true,
      );
    });

    test("scheduled -> cancelled is valid", () => {
      expect(
        TaskStateMachine.validateTransition("scheduled", "cancelled"),
      ).toBe(true);
    });

    test("running -> done is valid", () => {
      expect(TaskStateMachine.validateTransition("running", "done")).toBe(true);
    });

    test("running -> failed is valid", () => {
      expect(TaskStateMachine.validateTransition("running", "failed")).toBe(
        true,
      );
    });

    test("running -> cancelled is valid", () => {
      expect(TaskStateMachine.validateTransition("running", "cancelled")).toBe(
        true,
      );
    });

    test("running -> blocked is valid", () => {
      expect(TaskStateMachine.validateTransition("running", "blocked")).toBe(
        true,
      );
    });

    test("blocked -> running is valid", () => {
      expect(TaskStateMachine.validateTransition("blocked", "running")).toBe(
        true,
      );
    });

    test("blocked -> cancelled is valid", () => {
      expect(TaskStateMachine.validateTransition("blocked", "cancelled")).toBe(
        true,
      );
    });

    test("done -> idle is valid", () => {
      expect(TaskStateMachine.validateTransition("done", "idle")).toBe(true);
    });

    test("failed -> idle is valid", () => {
      expect(TaskStateMachine.validateTransition("failed", "idle")).toBe(true);
    });

    test("cancelled -> idle is valid", () => {
      expect(TaskStateMachine.validateTransition("cancelled", "idle")).toBe(
        true,
      );
    });

    test("idle -> running is invalid", () => {
      expect(TaskStateMachine.validateTransition("idle", "running")).toBe(
        false,
      );
    });

    test("idle -> done is invalid", () => {
      expect(TaskStateMachine.validateTransition("idle", "done")).toBe(false);
    });

    test("scheduled -> done is invalid", () => {
      expect(TaskStateMachine.validateTransition("scheduled", "done")).toBe(
        false,
      );
    });

    test("scheduled -> blocked is invalid", () => {
      expect(TaskStateMachine.validateTransition("scheduled", "blocked")).toBe(
        false,
      );
    });

    test("running -> scheduled is invalid", () => {
      expect(TaskStateMachine.validateTransition("running", "scheduled")).toBe(
        false,
      );
    });

    test("blocked -> scheduled is invalid", () => {
      expect(TaskStateMachine.validateTransition("blocked", "scheduled")).toBe(
        false,
      );
    });

    test("blocked -> done is invalid", () => {
      expect(TaskStateMachine.validateTransition("blocked", "done")).toBe(
        false,
      );
    });

    test("done -> running is invalid", () => {
      expect(TaskStateMachine.validateTransition("done", "running")).toBe(
        false,
      );
    });

    test("done -> scheduled is invalid", () => {
      expect(TaskStateMachine.validateTransition("done", "scheduled")).toBe(
        false,
      );
    });
  });

  describe("isTerminalState", () => {
    test("done is terminal", () => {
      expect(TaskStateMachine.isTerminalState("done")).toBe(true);
    });

    test("failed is terminal", () => {
      expect(TaskStateMachine.isTerminalState("failed")).toBe(true);
    });

    test("cancelled is terminal", () => {
      expect(TaskStateMachine.isTerminalState("cancelled")).toBe(true);
    });

    test("idle is not terminal", () => {
      expect(TaskStateMachine.isTerminalState("idle")).toBe(false);
    });

    test("scheduled is not terminal", () => {
      expect(TaskStateMachine.isTerminalState("scheduled")).toBe(false);
    });

    test("running is not terminal", () => {
      expect(TaskStateMachine.isTerminalState("running")).toBe(false);
    });

    test("blocked is not terminal", () => {
      expect(TaskStateMachine.isTerminalState("blocked")).toBe(false);
    });
  });

  describe("shouldAutoReset", () => {
    test("task with no triggers should not auto-reset", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "One-time task",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(TaskStateMachine.shouldAutoReset(task)).toBe(false);
    });

    test("task with only once trigger should not auto-reset", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "One-time task",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [{ id: "trigger-1", type: "once", at: Date.now() }],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(TaskStateMachine.shouldAutoReset(task)).toBe(false);
    });

    test("task with cron trigger should auto-reset", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "Recurring task",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [{ id: "trigger-1", type: "cron", expr: "0 0 * * *" }],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(TaskStateMachine.shouldAutoReset(task)).toBe(true);
    });

    test("task with interval trigger should auto-reset", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "Recurring task",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [{ id: "trigger-1", type: "interval", ms: 60000 }],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(TaskStateMachine.shouldAutoReset(task)).toBe(true);
    });

    test("task with event trigger should auto-reset", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "Event-driven task",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [{ id: "trigger-1", type: "event", name: "user.created" }],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(TaskStateMachine.shouldAutoReset(task)).toBe(true);
    });

    test("task with manual trigger should auto-reset", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "Manual task",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [{ id: "trigger-1", type: "manual" }],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(TaskStateMachine.shouldAutoReset(task)).toBe(true);
    });

    test("task with mixed triggers (once + cron) should auto-reset", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "Hybrid task",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [
          { id: "trigger-1", type: "once", at: Date.now() },
          { id: "trigger-2", type: "cron", expr: "0 0 * * *" },
        ],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(TaskStateMachine.shouldAutoReset(task)).toBe(true);
    });
  });

  describe("deriveStatus", () => {
    const baseTask: Task.Info = {
      id: "task-1",
      title: "Test task",
      owner: { type: "user", id: "user-1" },
      status: "idle",
      triggers: [{ id: "trigger-1", type: "cron", expr: "0 0 * * *" }],
      policy: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    test("derives idle when no runs", () => {
      expect(TaskStateMachine.deriveStatus(baseTask)).toBe("idle");
    });

    test("derives scheduled from pending run", () => {
      const pendingRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      expect(TaskStateMachine.deriveStatus(baseTask, pendingRun)).toBe(
        "scheduled",
      );
    });

    test("derives running from pending run", () => {
      const pendingRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "running",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
      };

      expect(TaskStateMachine.deriveStatus(baseTask, pendingRun)).toBe(
        "running",
      );
    });

    test("derives blocked from pending run", () => {
      const pendingRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "blocked",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
      };

      expect(TaskStateMachine.deriveStatus(baseTask, pendingRun)).toBe(
        "blocked",
      );
    });

    test("auto-resets to idle for recurring task after done", () => {
      const lastRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "done",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
      };

      expect(TaskStateMachine.deriveStatus(baseTask, undefined, lastRun)).toBe(
        "idle",
      );
    });

    test("auto-resets to idle for recurring task after failed", () => {
      const lastRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "failed",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
        error: "Something went wrong",
      };

      expect(TaskStateMachine.deriveStatus(baseTask, undefined, lastRun)).toBe(
        "idle",
      );
    });

    test("auto-resets to idle for recurring task after cancelled", () => {
      const lastRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "cancelled",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
      };

      expect(TaskStateMachine.deriveStatus(baseTask, undefined, lastRun)).toBe(
        "idle",
      );
    });

    test("keeps done status for one-time task", () => {
      const oneTimeTask: Task.Info = {
        ...baseTask,
        triggers: [{ id: "trigger-1", type: "once", at: Date.now() }],
      };

      const lastRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "done",
        trigger: { id: "trigger-1", type: "once" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
      };

      expect(
        TaskStateMachine.deriveStatus(oneTimeTask, undefined, lastRun),
      ).toBe("done");
    });

    test("keeps failed status for one-time task", () => {
      const oneTimeTask: Task.Info = {
        ...baseTask,
        triggers: [{ id: "trigger-1", type: "once", at: Date.now() }],
      };

      const lastRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "failed",
        trigger: { id: "trigger-1", type: "once" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
        error: "Failed",
      };

      expect(
        TaskStateMachine.deriveStatus(oneTimeTask, undefined, lastRun),
      ).toBe("failed");
    });

    test("keeps cancelled status for one-time task", () => {
      const oneTimeTask: Task.Info = {
        ...baseTask,
        triggers: [],
      };

      const lastRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "cancelled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
      };

      expect(
        TaskStateMachine.deriveStatus(oneTimeTask, undefined, lastRun),
      ).toBe("cancelled");
    });

    test("prefers pending run status over last run", () => {
      const pendingRun: Task.Run = {
        runId: "run-2",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-2",
        status: "running",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-2",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
      };

      const lastRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "done",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now() - 1000,
        startedAt: Date.now() - 1000,
        endedAt: Date.now() - 500,
      };

      expect(TaskStateMachine.deriveStatus(baseTask, pendingRun, lastRun)).toBe(
        "running",
      );
    });
  });

  describe("applyTransition", () => {
    const baseTask: Task.Info = {
      id: "task-1",
      title: "Test task",
      owner: { type: "user", id: "user-1" },
      status: "idle",
      triggers: [{ id: "trigger-1", type: "cron", expr: "0 0 * * *" }],
      policy: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    test("applies valid transition", () => {
      const beforeTime = Date.now();
      const updated = TaskStateMachine.applyTransition(baseTask, "scheduled");
      expect(updated.status).toBe("scheduled");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(beforeTime);
    });

    test("throws error on invalid transition", () => {
      expect(() => {
        TaskStateMachine.applyTransition(baseTask, "running");
      }).toThrow("Invalid state transition: idle -> running");
    });

    test("auto-resets recurring task from done to idle", () => {
      const doneTask: Task.Info = { ...baseTask, status: "running" };
      const updated = TaskStateMachine.applyTransition(doneTask, "done");
      expect(updated.status).toBe("idle");
    });

    test("auto-resets recurring task from failed to idle", () => {
      const runningTask: Task.Info = { ...baseTask, status: "running" };
      const updated = TaskStateMachine.applyTransition(runningTask, "failed");
      expect(updated.status).toBe("idle");
    });

    test("auto-resets recurring task from cancelled to idle", () => {
      const runningTask: Task.Info = { ...baseTask, status: "running" };
      const updated = TaskStateMachine.applyTransition(
        runningTask,
        "cancelled",
      );
      expect(updated.status).toBe("idle");
    });

    test("keeps terminal state for one-time task", () => {
      const oneTimeTask: Task.Info = {
        ...baseTask,
        status: "running",
        triggers: [{ id: "trigger-1", type: "once", at: Date.now() }],
      };
      const updated = TaskStateMachine.applyTransition(oneTimeTask, "done");
      expect(updated.status).toBe("done");
    });
  });

  describe("getValidNextStates", () => {
    test("returns valid next states for idle", () => {
      const nextStates = TaskStateMachine.getValidNextStates("idle");
      expect(nextStates).toEqual(["scheduled"]);
    });

    test("returns valid next states for scheduled", () => {
      const nextStates = TaskStateMachine.getValidNextStates("scheduled");
      expect(nextStates).toEqual(["running", "cancelled"]);
    });

    test("returns valid next states for running", () => {
      const nextStates = TaskStateMachine.getValidNextStates("running");
      expect(nextStates).toEqual(["done", "failed", "cancelled", "blocked"]);
    });

    test("returns valid next states for blocked", () => {
      const nextStates = TaskStateMachine.getValidNextStates("blocked");
      expect(nextStates).toEqual(["running", "cancelled"]);
    });

    test("returns valid next states for done", () => {
      const nextStates = TaskStateMachine.getValidNextStates("done");
      expect(nextStates).toEqual(["idle"]);
    });

    test("returns valid next states for failed", () => {
      const nextStates = TaskStateMachine.getValidNextStates("failed");
      expect(nextStates).toEqual(["idle"]);
    });

    test("returns valid next states for cancelled", () => {
      const nextStates = TaskStateMachine.getValidNextStates("cancelled");
      expect(nextStates).toEqual(["idle"]);
    });
  });
});

describe("TaskStatusManager", () => {
  const baseTask: Task.Info = {
    id: "task-1",
    title: "Test task",
    owner: { type: "user", id: "user-1" },
    status: "idle",
    triggers: [{ id: "trigger-1", type: "cron", expr: "0 0 * * *" }],
    policy: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  describe("setStatus", () => {
    test("sets valid status", () => {
      const updated = TaskStatusManager.setStatus(baseTask, "scheduled");
      expect(updated.status).toBe("scheduled");
    });

    test("throws error on invalid status transition", () => {
      expect(() => {
        TaskStatusManager.setStatus(baseTask, "running");
      }).toThrow("Invalid state transition: idle -> running");
    });

    test("auto-resets recurring task to idle", () => {
      const runningTask: Task.Info = { ...baseTask, status: "running" };
      const updated = TaskStatusManager.setStatus(runningTask, "done");
      expect(updated.status).toBe("idle");
    });
  });

  describe("updateFromRun", () => {
    test("updates status from pending run", () => {
      const pendingRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "running",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
      };

      const updated = TaskStatusManager.updateFromRun(baseTask, pendingRun);
      expect(updated.status).toBe("running");
      expect(updated.pendingRun).toEqual(pendingRun);
    });

    test("updates status from last run", () => {
      const lastRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "done",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
        startedAt: Date.now(),
        endedAt: Date.now(),
      };

      const updated = TaskStatusManager.updateFromRun(
        baseTask,
        undefined,
        lastRun,
      );
      expect(updated.status).toBe("idle");
      expect(updated.lastRun).toEqual(lastRun);
    });

    test("updates both pending and last run", () => {
      const pendingRun: Task.Run = {
        runId: "run-2",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-2",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-2",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      const lastRun: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "done",
        trigger: { id: "trigger-1", type: "cron" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now() - 1000,
        startedAt: Date.now() - 1000,
        endedAt: Date.now() - 500,
      };

      const updated = TaskStatusManager.updateFromRun(
        baseTask,
        pendingRun,
        lastRun,
      );
      expect(updated.status).toBe("scheduled");
      expect(updated.pendingRun).toEqual(pendingRun);
      expect(updated.lastRun).toEqual(lastRun);
    });

    test("updates timestamp", () => {
      const pastTask: Task.Info = {
        ...baseTask,
        updatedAt: baseTask.updatedAt - 1,
      };
      const updated = TaskStatusManager.updateFromRun(pastTask);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(pastTask.updatedAt + 1);
    });
  });
});
