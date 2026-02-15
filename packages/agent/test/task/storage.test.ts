import { describe, expect, test, beforeEach } from "bun:test";
import { InMemoryTaskStore } from "../../src/task/storage";
import type { Task } from "../../src/task/types";

describe("InMemoryTaskStore", () => {
  let store: InMemoryTaskStore;

  beforeEach(() => {
    store = new InMemoryTaskStore();
  });

  describe("task operations", () => {
    test("get returns undefined for non-existent task", () => {
      expect(store.task.get("non-existent")).toBeUndefined();
    });

    test("set and get task", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "Test Task",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      store.task.set("task-1", task);
      expect(store.task.get("task-1")).toEqual(task);
    });

    test("list returns all tasks", () => {
      const task1: Task.Info = {
        id: "task-1",
        title: "Task 1",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const task2: Task.Info = {
        id: "task-2",
        title: "Task 2",
        owner: { type: "user", id: "user-2" },
        status: "running",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      store.task.set("task-1", task1);
      store.task.set("task-2", task2);

      const tasks = store.task.list();
      expect(tasks).toHaveLength(2);
      expect(tasks).toContainEqual(task1);
      expect(tasks).toContainEqual(task2);
    });

    test("list filters by status", () => {
      const task1: Task.Info = {
        id: "task-1",
        title: "Task 1",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const task2: Task.Info = {
        id: "task-2",
        title: "Task 2",
        owner: { type: "user", id: "user-2" },
        status: "running",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      store.task.set("task-1", task1);
      store.task.set("task-2", task2);

      const idleTasks = store.task.list({ status: "idle" });
      expect(idleTasks).toHaveLength(1);
      expect(idleTasks[0].id).toBe("task-1");

      const runningTasks = store.task.list({ status: ["running"] });
      expect(runningTasks).toHaveLength(1);
      expect(runningTasks[0].id).toBe("task-2");
    });

    test("list filters by ownerId", () => {
      const task1: Task.Info = {
        id: "task-1",
        title: "Task 1",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const task2: Task.Info = {
        id: "task-2",
        title: "Task 2",
        owner: { type: "user", id: "user-2" },
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      store.task.set("task-1", task1);
      store.task.set("task-2", task2);

      const user1Tasks = store.task.list({ ownerId: "user-1" });
      expect(user1Tasks).toHaveLength(1);
      expect(user1Tasks[0].id).toBe("task-1");
    });

    test("list filters by assignedAgentId", () => {
      const task1: Task.Info = {
        id: "task-1",
        title: "Task 1",
        owner: { type: "user", id: "user-1" },
        assignedAgentId: "agent-1",
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const task2: Task.Info = {
        id: "task-2",
        title: "Task 2",
        owner: { type: "user", id: "user-2" },
        assignedAgentId: "agent-2",
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      store.task.set("task-1", task1);
      store.task.set("task-2", task2);

      const agent1Tasks = store.task.list({ assignedAgentId: "agent-1" });
      expect(agent1Tasks).toHaveLength(1);
      expect(agent1Tasks[0].id).toBe("task-1");
    });

    test("list filters by tags", () => {
      const task1: Task.Info = {
        id: "task-1",
        title: "Task 1",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [],
        policy: {},
        tags: ["urgent", "backend"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const task2: Task.Info = {
        id: "task-2",
        title: "Task 2",
        owner: { type: "user", id: "user-2" },
        status: "idle",
        triggers: [],
        policy: {},
        tags: ["urgent", "frontend"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      store.task.set("task-1", task1);
      store.task.set("task-2", task2);

      const urgentTasks = store.task.list({ tags: ["urgent"] });
      expect(urgentTasks).toHaveLength(2);

      const backendTasks = store.task.list({ tags: ["urgent", "backend"] });
      expect(backendTasks).toHaveLength(1);
      expect(backendTasks[0].id).toBe("task-1");
    });

    test("remove deletes task and associated runs", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "Task 1",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const run: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      store.task.set("task-1", task);
      store.run.set("task-1", run);

      expect(store.task.remove("task-1")).toBe(true);
      expect(store.task.get("task-1")).toBeUndefined();
      expect(store.run.get("run-1")).toBeUndefined();
    });

    test("remove returns false for non-existent task", () => {
      expect(store.task.remove("non-existent")).toBe(false);
    });
  });

  describe("run operations", () => {
    test("get returns undefined for non-existent run", () => {
      expect(store.run.get("non-existent")).toBeUndefined();
    });

    test("set and get run", () => {
      const run: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      store.run.set("task-1", run);
      expect(store.run.get("run-1")).toEqual(run);
    });

    test("set updates status index when status changes", () => {
      const run: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      store.run.set("task-1", run);

      let scheduledRuns = store.run.listByStatus(["scheduled"]);
      expect(scheduledRuns).toHaveLength(1);

      const updatedRun = { ...run, status: "running" as const };
      store.run.set("task-1", updatedRun);

      scheduledRuns = store.run.listByStatus(["scheduled"]);
      expect(scheduledRuns).toHaveLength(0);

      const runningRuns = store.run.listByStatus(["running"]);
      expect(runningRuns).toHaveLength(1);
      expect(runningRuns[0].runId).toBe("run-1");
    });

    test("list returns runs for task", () => {
      const run1: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      const run2: Task.Run = {
        runId: "run-2",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-2",
        status: "done",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-2",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      store.run.set("task-1", run1);
      store.run.set("task-1", run2);

      const runs = store.run.list("task-1");
      expect(runs).toHaveLength(2);
    });

    test("list sorts runs by scheduledAt", () => {
      const now = Date.now();
      const run1: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "done",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: now - 1000,
      };

      const run2: Task.Run = {
        runId: "run-2",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-2",
        status: "done",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-2",
        attempt: 1,
        scheduledAt: now,
      };

      store.run.set("task-1", run1);
      store.run.set("task-1", run2);

      const runsDesc = store.run.list("task-1", {
        sortBy: "scheduledAt",
        sortOrder: "desc",
      });
      expect(runsDesc[0].runId).toBe("run-2");
      expect(runsDesc[1].runId).toBe("run-1");

      const runsAsc = store.run.list("task-1", {
        sortBy: "scheduledAt",
        sortOrder: "asc",
      });
      expect(runsAsc[0].runId).toBe("run-1");
      expect(runsAsc[1].runId).toBe("run-2");
    });

    test("list paginates runs", () => {
      for (let i = 0; i < 5; i++) {
        const run: Task.Run = {
          runId: `run-${i}`,
          taskId: "task-1",
          sessionKey: `task:task-1:run:run-${i}`,
          status: "done",
          trigger: { id: "trigger-1", type: "manual" },
          idempotencyKey: `idem-${i}`,
          attempt: 1,
          scheduledAt: Date.now() + i,
        };
        store.run.set("task-1", run);
      }

      const page1 = store.run.list("task-1", { limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = store.run.list("task-1", { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = store.run.list("task-1", { limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });

    test("listByStatus returns runs with matching status", () => {
      const run1: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      const run2: Task.Run = {
        runId: "run-2",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-2",
        status: "running",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-2",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      const run3: Task.Run = {
        runId: "run-3",
        taskId: "task-2",
        sessionKey: "task:task-2:run:run-3",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-3",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      store.run.set("task-1", run1);
      store.run.set("task-1", run2);
      store.run.set("task-2", run3);

      const scheduledRuns = store.run.listByStatus(["scheduled"]);
      expect(scheduledRuns).toHaveLength(2);
      expect(scheduledRuns.map((r) => r.runId).sort()).toEqual([
        "run-1",
        "run-3",
      ]);

      const activeRuns = store.run.listByStatus(["scheduled", "running"]);
      expect(activeRuns).toHaveLength(3);
    });

    test("remove deletes run and updates indexes", () => {
      const run: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      store.run.set("task-1", run);

      expect(store.run.remove("run-1")).toBe(true);
      expect(store.run.get("run-1")).toBeUndefined();
      expect(store.run.listByStatus(["scheduled"])).toHaveLength(0);
      expect(store.hasIdempotencyKey("idem-1")).toBe(false);
    });

    test("remove returns false for non-existent run", () => {
      expect(store.run.remove("non-existent")).toBe(false);
    });
  });

  describe("idempotency operations", () => {
    test("hasIdempotencyKey returns false for non-existent key", () => {
      expect(store.hasIdempotencyKey("non-existent")).toBe(false);
    });

    test("hasIdempotencyKey returns true after run is set", () => {
      const run: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      store.run.set("task-1", run);
      expect(store.hasIdempotencyKey("idem-1")).toBe(true);
    });

    test("getByIdempotencyKey returns run", () => {
      const run: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      store.run.set("task-1", run);
      expect(store.getByIdempotencyKey("idem-1")).toEqual(run);
    });

    test("getByIdempotencyKey returns undefined for non-existent key", () => {
      expect(store.getByIdempotencyKey("non-existent")).toBeUndefined();
    });
  });

  describe("clear", () => {
    test("clear removes all data", () => {
      const task: Task.Info = {
        id: "task-1",
        title: "Task 1",
        owner: { type: "user", id: "user-1" },
        status: "idle",
        triggers: [],
        policy: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const run: Task.Run = {
        runId: "run-1",
        taskId: "task-1",
        sessionKey: "task:task-1:run:run-1",
        status: "scheduled",
        trigger: { id: "trigger-1", type: "manual" },
        idempotencyKey: "idem-1",
        attempt: 1,
        scheduledAt: Date.now(),
      };

      store.task.set("task-1", task);
      store.run.set("task-1", run);

      store.clear();

      expect(store.task.list()).toHaveLength(0);
      expect(store.run.listByStatus(["scheduled"])).toHaveLength(0);
      expect(store.hasIdempotencyKey("idem-1")).toBe(false);
    });
  });
});
