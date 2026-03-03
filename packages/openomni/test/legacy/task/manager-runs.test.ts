import { describe, expect, test, beforeEach } from "bun:test";
import { TaskManager } from "../../../src/legacy/task/manager";
import { TaskStorage } from "../../../src/legacy/task/storage";
import type { Task } from "../../../src/legacy/task/types";

describe("TaskManager - Run Management APIs", () => {
  beforeEach(() => {
    TaskStorage.reset();
  });

  function createTask(overrides: Partial<Task.CreateInput> = {}): Task.Info {
    return TaskManager.create({
      title: "Test Task",
      owner: { type: "user", id: "user-1" },
      triggers: [{ id: "manual-1", type: "manual" }],
      ...overrides,
    });
  }

  function createSignal(
    overrides: Partial<Task.TriggerSignal> = {},
  ): Task.TriggerSignal {
    return {
      triggerId: "manual-1",
      type: "manual",
      occurredAt: Date.now(),
      ...overrides,
    };
  }

  async function createRun(
    taskId: string,
    overrides: Partial<Task.TriggerSignal> = {},
  ): Promise<string> {
    const result = await TaskManager.trigger(taskId, createSignal(overrides));
    if ("runId" in result) {
      return result.runId;
    }
    throw new Error(`Failed to create run: ${result.error}`);
  }

  describe("getRun", () => {
    test("returns undefined for non-existent run", () => {
      const run = TaskManager.getRun("non-existent");
      expect(run).toBeUndefined();
    });

    test("returns run by ID", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const run = TaskManager.getRun(runId);
      expect(run).toBeDefined();
      expect(run?.runId).toBe(runId);
      expect(run?.taskId).toBe(task.id);
    });

    test("returns correct run status", async () => {
      const task = createTask({ policy: { permission: "notify" } });
      const runId = await createRun(task.id);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("scheduled");
    });
  });

  describe("listRuns", () => {
    test("returns empty array for task with no runs", () => {
      const task = createTask();
      const runs = TaskManager.listRuns(task.id);
      expect(runs).toEqual([]);
    });

    test("returns all runs for a task", async () => {
      const task = createTask();
      const runId1 = await createRun(task.id);
      const runId2 = await createRun(task.id);

      const runs = TaskManager.listRuns(task.id);
      expect(runs.length).toBe(2);
      expect(runs.map((r) => r.runId)).toContain(runId1);
      expect(runs.map((r) => r.runId)).toContain(runId2);
    });

    test("filters runs by status", async () => {
      const task = createTask({ policy: { permission: "notify" } });
      const runId1 = await createRun(task.id);
      const runId2 = await createRun(task.id);

      TaskManager.setRunStatus(runId1, "running");

      const scheduledRuns = TaskManager.listRuns(task.id, {
        status: "scheduled",
      });
      expect(scheduledRuns.length).toBe(1);
      expect(scheduledRuns[0].runId).toBe(runId2);

      const runningRuns = TaskManager.listRuns(task.id, { status: "running" });
      expect(runningRuns.length).toBe(1);
      expect(runningRuns[0].runId).toBe(runId1);
    });

    test("supports pagination with limit and offset", async () => {
      const task = createTask();
      const runIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        runIds.push(await createRun(task.id));
      }

      const page1 = TaskManager.listRuns(task.id, { limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      const page2 = TaskManager.listRuns(task.id, { limit: 2, offset: 2 });
      expect(page2.length).toBe(2);

      const page3 = TaskManager.listRuns(task.id, { limit: 2, offset: 4 });
      expect(page3.length).toBe(1);
    });

    test("returns empty array for non-existent task", () => {
      const runs = TaskManager.listRuns("non-existent");
      expect(runs).toEqual([]);
    });
  });

  describe("listRunsByStatus", () => {
    test("returns empty array when no runs match status", () => {
      const runs = TaskManager.listRunsByStatus("done");
      expect(runs).toEqual([]);
    });

    test("returns runs with matching status", async () => {
      const task1 = createTask();
      const task2 = createTask();

      const run1 = await createRun(task1.id);
      const run2 = await createRun(task2.id);

      TaskManager.setRunStatus(run1, "running");
      TaskManager.setRunStatus(run2, "done");

      const runningRuns = TaskManager.listRunsByStatus("running");
      expect(runningRuns.length).toBe(1);
      expect(runningRuns[0].runId).toBe(run1);

      const doneRuns = TaskManager.listRunsByStatus("done");
      expect(doneRuns.length).toBe(1);
      expect(doneRuns[0].runId).toBe(run2);
    });

    test("accepts array of statuses", async () => {
      const task = createTask();
      const run1 = await createRun(task.id);
      const run2 = await createRun(task.id);
      const run3 = await createRun(task.id);

      TaskManager.setRunStatus(run1, "running");
      TaskManager.setRunStatus(run2, "done");

      const statusArray: Array<Task.Run["status"]> = ["running", "done"];
      const runs = TaskManager.listRunsByStatus(statusArray);
      expect(runs.length).toBe(2);
      expect(runs.map((r) => r.runId)).toContain(run1);
      expect(runs.map((r) => r.runId)).toContain(run2);
    });

    test("supports pagination", async () => {
      const task = createTask();
      for (let i = 0; i < 5; i++) {
        const runId = await createRun(task.id);
        TaskManager.setRunStatus(runId, "done");
      }

      const page1 = TaskManager.listRunsByStatus("done", {
        limit: 2,
        offset: 0,
      });
      expect(page1.length).toBe(2);

      const page2 = TaskManager.listRunsByStatus("done", {
        limit: 2,
        offset: 2,
      });
      expect(page2.length).toBe(2);

      const page3 = TaskManager.listRunsByStatus("done", {
        limit: 2,
        offset: 4,
      });
      expect(page3.length).toBe(1);
    });
  });

  describe("setRunStatus", () => {
    test("returns false for non-existent run", () => {
      const result = TaskManager.setRunStatus("non-existent", "running");
      expect(result).toBe(false);
    });

    test("updates run status", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const result = TaskManager.setRunStatus(runId, "running");
      expect(result).toBe(true);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("running");
    });

    test("sets startedAt when transitioning to running", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const before = TaskManager.getRun(runId);
      expect(before?.startedAt).toBeUndefined();

      TaskManager.setRunStatus(runId, "running");

      const after = TaskManager.getRun(runId);
      expect(after?.startedAt).toBeDefined();
      expect(after!.startedAt! > 0).toBe(true);
    });

    test("sets endedAt when transitioning to terminal status", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      TaskManager.setRunStatus(runId, "running");
      TaskManager.setRunStatus(runId, "done");

      const run = TaskManager.getRun(runId);
      expect(run?.endedAt).toBeDefined();
      expect(run!.endedAt! > 0).toBe(true);
    });

    test("updates task status", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      TaskManager.setRunStatus(runId, "running");

      const updatedTask = TaskManager.get(task.id);
      expect(updatedTask?.status).toBe("running");
    });

    test("accepts optional reason parameter", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const result = TaskManager.setRunStatus(
        runId,
        "cancelled",
        "user_requested",
      );
      expect(result).toBe(true);
    });
  });

  describe("cancelRun", () => {
    test("returns false for non-existent run", () => {
      const result = TaskManager.cancelRun("non-existent");
      expect(result).toBe(false);
    });

    test("cancels scheduled run", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const result = TaskManager.cancelRun(runId);
      expect(result).toBe(true);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("cancelled");
    });

    test("cancels running run", async () => {
      const task = createTask();
      const runId = await createRun(task.id);
      TaskManager.setRunStatus(runId, "running");

      const result = TaskManager.cancelRun(runId);
      expect(result).toBe(true);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("cancelled");
    });

    test("cancels blocked run", async () => {
      const task = createTask({ policy: { permission: "ask" } });
      const runId = await createRun(task.id);

      const result = TaskManager.cancelRun(runId);
      expect(result).toBe(true);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("cancelled");
    });

    test("cannot cancel already done run", async () => {
      const task = createTask();
      const runId = await createRun(task.id);
      TaskManager.setRunStatus(runId, "done");

      const result = TaskManager.cancelRun(runId);
      expect(result).toBe(false);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("done");
    });

    test("cannot cancel already failed run", async () => {
      const task = createTask();
      const runId = await createRun(task.id);
      TaskManager.setRunStatus(runId, "failed");

      const result = TaskManager.cancelRun(runId);
      expect(result).toBe(false);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("failed");
    });

    test("cannot cancel already cancelled run", async () => {
      const task = createTask();
      const runId = await createRun(task.id);
      TaskManager.cancelRun(runId);

      const result = TaskManager.cancelRun(runId);
      expect(result).toBe(false);
    });

    test("accepts optional reason parameter", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const result = TaskManager.cancelRun(runId, "user_requested");
      expect(result).toBe(true);
    });
  });

  describe("resumeRun", () => {
    test("returns false for non-existent run", () => {
      const result = TaskManager.resumeRun("non-existent");
      expect(result).toBe(false);
    });

    test("resumes blocked run", async () => {
      const task = createTask({ policy: { permission: "ask" } });
      const runId = await createRun(task.id);

      const result = TaskManager.resumeRun(runId);
      expect(result).toBe(true);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("scheduled");
    });

    test("cannot resume non-blocked run", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const result = TaskManager.resumeRun(runId);
      expect(result).toBe(false);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("scheduled");
    });

    test("accepts approval context", async () => {
      const task = createTask({ policy: { permission: "ask" } });
      const runId = await createRun(task.id);

      const result = TaskManager.resumeRun(runId, {
        approvedBy: "admin-1",
        approvalType: "once",
      });
      expect(result).toBe(true);

      const run = TaskManager.getRun(runId);
      expect(run?.status).toBe("scheduled");
    });

    test("persists 'always' approval to task policy", async () => {
      const task = createTask({ policy: { permission: "ask" } });
      const runId = await createRun(task.id);

      const result = TaskManager.resumeRun(runId, {
        approvedBy: "admin-1",
        approvalType: "always",
      });
      expect(result).toBe(true);

      const updatedTask = TaskManager.get(task.id);
      expect(updatedTask?.policy.permission).toBe("notify");
    });

    test("does not change policy for 'once' approval", async () => {
      const task = createTask({ policy: { permission: "ask" } });
      const runId = await createRun(task.id);

      const result = TaskManager.resumeRun(runId, {
        approvedBy: "admin-1",
        approvalType: "once",
      });
      expect(result).toBe(true);

      const updatedTask = TaskManager.get(task.id);
      expect(updatedTask?.policy.permission).toBe("ask");
    });
  });

  describe("listBlockedRuns", () => {
    test("returns empty array when no blocked runs", () => {
      const runs = TaskManager.listBlockedRuns();
      expect(runs).toEqual([]);
    });

    test("returns all blocked runs", async () => {
      const task1 = createTask({
        policy: {
          permission: "ask",
          concurrency: { maxRunning: 10, mode: "queue" },
        },
      });
      const task2 = createTask({
        policy: {
          permission: "ask",
          concurrency: { maxRunning: 10, mode: "queue" },
        },
      });

      const run1 = await createRun(task1.id, { occurredAt: Date.now() });
      const run2 = await createRun(task2.id, { occurredAt: Date.now() + 1 });
      const run3 = await createRun(task1.id, { occurredAt: Date.now() + 2 });

      const blockedRuns = TaskManager.listBlockedRuns();
      expect(blockedRuns.length).toBe(3);
      expect(blockedRuns.map((r) => r.runId)).toContain(run1);
      expect(blockedRuns.map((r) => r.runId)).toContain(run2);
      expect(blockedRuns.map((r) => r.runId)).toContain(run3);
    });

    test("filters by taskId", async () => {
      const task1 = createTask({
        policy: {
          permission: "ask",
          concurrency: { maxRunning: 10, mode: "queue" },
        },
      });
      const task2 = createTask({
        policy: {
          permission: "ask",
          concurrency: { maxRunning: 10, mode: "queue" },
        },
      });

      const run1 = await createRun(task1.id, { occurredAt: Date.now() });
      const run2 = await createRun(task2.id, { occurredAt: Date.now() + 1 });
      const run3 = await createRun(task1.id, { occurredAt: Date.now() + 2 });

      const task1Blocked = TaskManager.listBlockedRuns({ taskId: task1.id });
      expect(task1Blocked.length).toBe(2);
      expect(task1Blocked.map((r) => r.runId)).toContain(run1);
      expect(task1Blocked.map((r) => r.runId)).toContain(run3);

      const task2Blocked = TaskManager.listBlockedRuns({ taskId: task2.id });
      expect(task2Blocked.length).toBe(1);
      expect(task2Blocked[0].runId).toBe(run2);
    });
  });
});
