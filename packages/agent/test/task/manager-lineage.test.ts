import { describe, expect, test, beforeEach } from "bun:test";
import { TaskManager } from "../../src/task/manager";
import { TaskStorage } from "../../src/task/storage";
import type { Task, TriggerSignal } from "../../src/task/types";

describe("TaskManager - Spawn Lineage Tracking", () => {
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

  function createSignal(overrides: Partial<TriggerSignal> = {}): TriggerSignal {
    return {
      triggerId: "manual-1",
      type: "manual",
      occurredAt: Date.now(),
      ...overrides,
    };
  }

  async function createRun(
    taskId: string,
    overrides: Partial<TriggerSignal> = {},
  ): Promise<string> {
    const result = await TaskManager.trigger(taskId, createSignal(overrides));
    if ("runId" in result) {
      return result.runId;
    }
    throw new Error(`Failed to create run: ${result.error}`);
  }

  describe("spawnedBy field on TaskRun", () => {
    test("root task run has no spawnedBy", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const run = TaskManager.getRun(runId);
      expect(run).toBeDefined();
      expect(run?.spawnedBy).toBeUndefined();
    });

    test("child task run records spawnedBy from trigger signal", async () => {
      const parentTask = createTask({ title: "Parent Task" });
      const parentRunId = await createRun(parentTask.id);

      const childTask = createTask({ title: "Child Task" });
      const childRunId = await createRun(childTask.id, {
        spawnedBy: {
          taskId: parentTask.id,
          runId: parentRunId,
          sessionId: "session-parent-1",
        },
      });

      const childRun = TaskManager.getRun(childRunId);
      expect(childRun).toBeDefined();
      expect(childRun?.spawnedBy).toEqual({
        taskId: parentTask.id,
        runId: parentRunId,
        sessionId: "session-parent-1",
      });
    });

    test("spawnedBy is preserved through status transitions", async () => {
      const parentTask = createTask({ title: "Parent Task" });
      const parentRunId = await createRun(parentTask.id);

      const childTask = createTask({ title: "Child Task" });
      const childRunId = await createRun(childTask.id, {
        spawnedBy: {
          taskId: parentTask.id,
          runId: parentRunId,
          sessionId: "session-1",
        },
      });

      TaskManager.setRunStatus(childRunId, "running");
      const runningRun = TaskManager.getRun(childRunId);
      expect(runningRun?.spawnedBy).toEqual({
        taskId: parentTask.id,
        runId: parentRunId,
        sessionId: "session-1",
      });

      TaskManager.setRunStatus(childRunId, "done");
      const doneRun = TaskManager.getRun(childRunId);
      expect(doneRun?.spawnedBy).toEqual({
        taskId: parentTask.id,
        runId: parentRunId,
        sessionId: "session-1",
      });
    });
  });

  describe("getLineage", () => {
    test("returns empty array for non-existent run", () => {
      const lineage = TaskManager.getLineage("non-existent");
      expect(lineage).toEqual([]);
    });

    test("returns empty array for root task (no spawnedBy)", async () => {
      const task = createTask();
      const runId = await createRun(task.id);

      const lineage = TaskManager.getLineage(runId);
      expect(lineage).toEqual([]);
    });

    test("returns parent for single-level child", async () => {
      const parentTask = createTask({ title: "Parent Task" });
      const parentRunId = await createRun(parentTask.id);

      const childTask = createTask({ title: "Child Task" });
      const childRunId = await createRun(childTask.id, {
        spawnedBy: {
          taskId: parentTask.id,
          runId: parentRunId,
          sessionId: "session-parent",
        },
      });

      const lineage = TaskManager.getLineage(childRunId);
      expect(lineage).toHaveLength(1);
      expect(lineage[0].runId).toBe(parentRunId);
      expect(lineage[0].taskId).toBe(parentTask.id);
    });

    test("returns full chain for grandchild (parent + grandparent)", async () => {
      const grandparentTask = createTask({ title: "Grandparent Task" });
      const grandparentRunId = await createRun(grandparentTask.id);

      const parentTask = createTask({ title: "Parent Task" });
      const parentRunId = await createRun(parentTask.id, {
        spawnedBy: {
          taskId: grandparentTask.id,
          runId: grandparentRunId,
          sessionId: "session-grandparent",
        },
      });

      const childTask = createTask({ title: "Child Task" });
      const childRunId = await createRun(childTask.id, {
        spawnedBy: {
          taskId: parentTask.id,
          runId: parentRunId,
          sessionId: "session-parent",
        },
      });

      const lineage = TaskManager.getLineage(childRunId);
      expect(lineage).toHaveLength(2);
      expect(lineage[0].runId).toBe(parentRunId);
      expect(lineage[1].runId).toBe(grandparentRunId);
    });

    test("stops at root when ancestor has no spawnedBy", async () => {
      const rootTask = createTask({ title: "Root" });
      const rootRunId = await createRun(rootTask.id);

      const midTask = createTask({ title: "Mid" });
      const midRunId = await createRun(midTask.id, {
        spawnedBy: {
          taskId: rootTask.id,
          runId: rootRunId,
          sessionId: "session-root",
        },
      });

      const leafTask = createTask({ title: "Leaf" });
      const leafRunId = await createRun(leafTask.id, {
        spawnedBy: {
          taskId: midTask.id,
          runId: midRunId,
          sessionId: "session-mid",
        },
      });

      const lineage = TaskManager.getLineage(leafRunId);
      expect(lineage).toHaveLength(2);
      expect(lineage[0].runId).toBe(midRunId);
      expect(lineage[1].runId).toBe(rootRunId);
    });

    test("handles broken chain gracefully (missing parent run)", async () => {
      const childTask = createTask({ title: "Orphan Child" });
      const childRunId = await createRun(childTask.id, {
        spawnedBy: {
          taskId: "deleted-task",
          runId: "deleted-run",
          sessionId: "deleted-session",
        },
      });

      const lineage = TaskManager.getLineage(childRunId);
      expect(lineage).toEqual([]);
    });

    test("lineage order is immediate parent first, root last", async () => {
      const t1 = createTask({ title: "Level 0" });
      const r1 = await createRun(t1.id);

      const t2 = createTask({ title: "Level 1" });
      const r2 = await createRun(t2.id, {
        spawnedBy: { taskId: t1.id, runId: r1, sessionId: "s1" },
      });

      const t3 = createTask({ title: "Level 2" });
      const r3 = await createRun(t3.id, {
        spawnedBy: { taskId: t2.id, runId: r2, sessionId: "s2" },
      });

      const t4 = createTask({ title: "Level 3" });
      const r4 = await createRun(t4.id, {
        spawnedBy: { taskId: t3.id, runId: r3, sessionId: "s3" },
      });

      const lineage = TaskManager.getLineage(r4);
      expect(lineage).toHaveLength(3);
      expect(lineage[0].runId).toBe(r3);
      expect(lineage[1].runId).toBe(r2);
      expect(lineage[2].runId).toBe(r1);
    });
  });
});
