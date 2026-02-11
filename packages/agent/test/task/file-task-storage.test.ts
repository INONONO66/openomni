import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileTaskStore } from "../../src/task/file-task-storage";
import { TaskStorage, InMemoryTaskStore } from "../../src/task/storage";
import type { Task, TaskRun } from "../../src/task/types";

function makeTask(id: string, overrides?: Partial<Task.Info>): Task.Info {
  return {
    id,
    title: `Task ${id}`,
    owner: { type: "user", id: "user-1" },
    status: "idle",
    triggers: [],
    policy: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeRun(
  runId: string,
  taskId: string,
  overrides?: Partial<TaskRun>,
): TaskRun {
  return {
    runId,
    taskId,
    sessionKey: `task:${taskId}:run:${runId}`,
    status: "scheduled",
    trigger: { id: "trigger-1", type: "manual" },
    idempotencyKey: `idem-${runId}`,
    attempt: 1,
    scheduledAt: Date.now(),
    ...overrides,
  };
}

describe("FileTaskStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-task-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("basic task operations", () => {
    test("set and get task", () => {
      const store = new FileTaskStore(dir);
      const task = makeTask("task-1");

      store.task.set("task-1", task);
      expect(store.task.get("task-1")).toEqual(task);
    });

    test("get returns undefined for non-existent task", () => {
      const store = new FileTaskStore(dir);
      expect(store.task.get("non-existent")).toBeUndefined();
    });

    test("list returns all tasks", () => {
      const store = new FileTaskStore(dir);
      store.task.set("task-1", makeTask("task-1"));
      store.task.set("task-2", makeTask("task-2", { status: "running" }));

      expect(store.task.list()).toHaveLength(2);
    });

    test("list filters by status", () => {
      const store = new FileTaskStore(dir);
      store.task.set("task-1", makeTask("task-1", { status: "idle" }));
      store.task.set("task-2", makeTask("task-2", { status: "running" }));

      expect(store.task.list({ status: "idle" })).toHaveLength(1);
      expect(store.task.list({ status: ["running"] })).toHaveLength(1);
    });

    test("remove deletes task and associated runs", () => {
      const store = new FileTaskStore(dir);
      store.task.set("task-1", makeTask("task-1"));
      store.run.set("task-1", makeRun("run-1", "task-1"));

      expect(store.task.remove("task-1")).toBe(true);
      expect(store.task.get("task-1")).toBeUndefined();
      expect(store.run.get("run-1")).toBeUndefined();
    });
  });

  describe("basic run operations", () => {
    test("set and get run", () => {
      const store = new FileTaskStore(dir);
      const run = makeRun("run-1", "task-1");

      store.run.set("task-1", run);
      expect(store.run.get("run-1")).toEqual(run);
    });

    test("listByStatus returns matching runs", () => {
      const store = new FileTaskStore(dir);
      store.run.set(
        "task-1",
        makeRun("run-1", "task-1", { status: "scheduled" }),
      );
      store.run.set(
        "task-1",
        makeRun("run-2", "task-1", { status: "running" }),
      );
      store.run.set(
        "task-2",
        makeRun("run-3", "task-2", { status: "scheduled" }),
      );

      const scheduled = store.run.listByStatus(["scheduled"]);
      expect(scheduled).toHaveLength(2);
      expect(scheduled.map((r) => r.runId).sort()).toEqual(["run-1", "run-3"]);
    });

    test("getByIdempotencyKey returns run", () => {
      const store = new FileTaskStore(dir);
      const run = makeRun("run-1", "task-1", { idempotencyKey: "my-key" });

      store.run.set("task-1", run);
      expect(store.run.getByIdempotencyKey("my-key")).toEqual(run);
    });

    test("status index updates on status change", () => {
      const store = new FileTaskStore(dir);
      const run = makeRun("run-1", "task-1", { status: "scheduled" });
      store.run.set("task-1", run);

      expect(store.run.listByStatus(["scheduled"])).toHaveLength(1);

      store.run.set("task-1", { ...run, status: "running" });

      expect(store.run.listByStatus(["scheduled"])).toHaveLength(0);
      expect(store.run.listByStatus(["running"])).toHaveLength(1);
    });

    test("remove deletes run and updates indexes", () => {
      const store = new FileTaskStore(dir);
      store.run.set("task-1", makeRun("run-1", "task-1"));

      expect(store.run.remove("run-1")).toBe(true);
      expect(store.run.get("run-1")).toBeUndefined();
      expect(store.run.listByStatus(["scheduled"])).toHaveLength(0);
      expect(store.run.getByIdempotencyKey("idem-run-1")).toBeUndefined();
    });

    test("list with sort and pagination", () => {
      const store = new FileTaskStore(dir);
      const now = Date.now();

      for (let i = 0; i < 5; i++) {
        store.run.set(
          "task-1",
          makeRun(`run-${i}`, "task-1", { scheduledAt: now + i }),
        );
      }

      const page = store.run.list("task-1", {
        sortBy: "scheduledAt",
        sortOrder: "asc",
        limit: 2,
        offset: 1,
      });

      expect(page).toHaveLength(2);
      expect(page[0].runId).toBe("run-1");
      expect(page[1].runId).toBe("run-2");
    });
  });

  describe("persistence across restart", () => {
    test("write task → restart → read task", () => {
      const task = makeTask("task-1");

      const store1 = new FileTaskStore(dir);
      store1.task.set("task-1", task);

      const store2 = new FileTaskStore(dir);
      expect(store2.task.get("task-1")).toEqual(task);
      expect(store2.task.list()).toHaveLength(1);
    });

    test("write run → restart → read run", () => {
      const run = makeRun("run-1", "task-1");

      const store1 = new FileTaskStore(dir);
      store1.run.set("task-1", run);

      const store2 = new FileTaskStore(dir);
      expect(store2.run.get("run-1")).toEqual(run);
    });

    test("write run with idempotency key → restart → lookup by idempotency key", () => {
      const run = makeRun("run-1", "task-1", {
        idempotencyKey: "unique-key-123",
      });

      const store1 = new FileTaskStore(dir);
      store1.run.set("task-1", run);

      const store2 = new FileTaskStore(dir);
      const found = store2.run.getByIdempotencyKey("unique-key-123");
      expect(found).toEqual(run);
    });

    test("write run → change status → restart → listByStatus", () => {
      const store1 = new FileTaskStore(dir);
      const run = makeRun("run-1", "task-1", { status: "scheduled" });
      store1.run.set("task-1", run);
      store1.run.set("task-1", { ...run, status: "running" });

      const store2 = new FileTaskStore(dir);
      expect(store2.run.listByStatus(["scheduled"])).toHaveLength(0);
      expect(store2.run.listByStatus(["running"])).toHaveLength(1);
      expect(store2.run.listByStatus(["running"])[0].runId).toBe("run-1");
    });

    test("multiple tasks and runs survive restart", () => {
      const store1 = new FileTaskStore(dir);
      store1.task.set("task-1", makeTask("task-1"));
      store1.task.set("task-2", makeTask("task-2"));
      store1.run.set("task-1", makeRun("run-1", "task-1", { status: "done" }));
      store1.run.set(
        "task-1",
        makeRun("run-2", "task-1", { status: "running" }),
      );
      store1.run.set(
        "task-2",
        makeRun("run-3", "task-2", { status: "scheduled" }),
      );

      const store2 = new FileTaskStore(dir);
      expect(store2.task.list()).toHaveLength(2);
      expect(store2.run.list("task-1")).toHaveLength(2);
      expect(store2.run.list("task-2")).toHaveLength(1);
      expect(store2.run.listByStatus(["done"])).toHaveLength(1);
      expect(store2.run.listByStatus(["running"])).toHaveLength(1);
      expect(store2.run.listByStatus(["scheduled"])).toHaveLength(1);
    });

    test("remove persists across restart", () => {
      const store1 = new FileTaskStore(dir);
      store1.task.set("task-1", makeTask("task-1"));
      store1.run.set("task-1", makeRun("run-1", "task-1"));
      store1.task.remove("task-1");

      const store2 = new FileTaskStore(dir);
      expect(store2.task.get("task-1")).toBeUndefined();
      expect(store2.run.get("run-1")).toBeUndefined();
      expect(store2.task.list()).toHaveLength(0);
    });
  });

  describe("clear", () => {
    test("clear removes all data from memory and disk", () => {
      const store1 = new FileTaskStore(dir);
      store1.task.set("task-1", makeTask("task-1"));
      store1.run.set("task-1", makeRun("run-1", "task-1"));
      store1.clear();

      expect(store1.task.list()).toHaveLength(0);
      expect(store1.run.listByStatus(["scheduled"])).toHaveLength(0);

      const store2 = new FileTaskStore(dir);
      expect(store2.task.list()).toHaveLength(0);
      expect(store2.run.listByStatus(["scheduled"])).toHaveLength(0);
    });
  });

  describe("TaskStorage.configure integration", () => {
    test("configure accepts FileTaskStore", () => {
      const store = new FileTaskStore(dir);
      TaskStorage.configure(store);

      const adapter = TaskStorage.getAdapter();
      expect(adapter).toBe(store);
    });
  });

  describe("InMemoryTaskStore remains default", () => {
    test("default adapter is InMemoryTaskStore", () => {
      TaskStorage.reset();
      const adapter = TaskStorage.getAdapter();
      expect(adapter).toBeInstanceOf(InMemoryTaskStore);
    });
  });
});
