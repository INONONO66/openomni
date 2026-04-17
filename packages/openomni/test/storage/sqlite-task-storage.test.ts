import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteTaskStore } from "../../src/storage/sqlite-task-storage";
import type { Task } from "../../src/storage/task-types";

function makeTask(overrides: Partial<Task.Info> = {}): Task.Info {
  return {
    id: "task-1",
    title: "Test Task",
    owner: { type: "user", id: "user-1" },
    status: "idle",
    ...overrides,
  };
}

function makeRun(overrides: Partial<Task.Run> = {}): Task.Run {
  return {
    runId: "run-1",
    taskId: "task-1",
    sessionKey: "ses-1",
    status: "scheduled",
    trigger: { id: "trig-1", type: "manual" },
    idempotencyKey: "idem-1",
    scheduledAt: Date.now(),
    attempt: 1,
    ...overrides,
  };
}

let store: SqliteTaskStore;
let dbPath: string;

beforeEach(() => {
  const dir = join(
    tmpdir(),
    `sqlite-task-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  dbPath = join(dir, "tasks.db");
  store = new SqliteTaskStore(dbPath);
});

afterEach(() => {
  store.close();
});

describe("task CRUD", () => {
  test("set and get", () => {
    const task = makeTask();
    store.task.set(task.id, task);
    expect(store.task.get(task.id)).toEqual(task);
  });

  test("get missing returns undefined", () => {
    expect(store.task.get("nope")).toBeUndefined();
  });

  test("list all", () => {
    store.task.set("t1", makeTask({ id: "t1" }));
    store.task.set("t2", makeTask({ id: "t2", status: "done" }));
    expect(store.task.list()).toHaveLength(2);
  });

  test("list by status", () => {
    store.task.set("t1", makeTask({ id: "t1", status: "idle" }));
    store.task.set("t2", makeTask({ id: "t2", status: "done" }));
    expect(store.task.list({ status: "idle" })).toHaveLength(1);
    expect(store.task.list({ status: ["idle", "done"] })).toHaveLength(2);
  });

  test("list by ownerId", () => {
    store.task.set("t1", makeTask({ id: "t1", owner: { type: "user", id: "alice" } }));
    store.task.set("t2", makeTask({ id: "t2", owner: { type: "user", id: "bob" } }));
    expect(store.task.list({ ownerId: "alice" })).toHaveLength(1);
  });

  test("list by assignedAgentId", () => {
    store.task.set("t1", makeTask({ id: "t1", assignedAgentId: "agent-x" }));
    store.task.set("t2", makeTask({ id: "t2" }));
    expect(store.task.list({ assignedAgentId: "agent-x" })).toHaveLength(1);
  });

  test("list by tags", () => {
    store.task.set("t1", makeTask({ id: "t1", tags: ["a", "b"] }));
    store.task.set("t2", makeTask({ id: "t2", tags: ["b"] }));
    expect(store.task.list({ tags: ["a"] })).toHaveLength(1);
    expect(store.task.list({ tags: ["b"] })).toHaveLength(2);
  });

  test("remove returns true if existed", () => {
    store.task.set("t1", makeTask({ id: "t1" }));
    expect(store.task.remove("t1")).toBe(true);
    expect(store.task.get("t1")).toBeUndefined();
  });

  test("remove returns false if missing", () => {
    expect(store.task.remove("ghost")).toBe(false);
  });

  test("set overwrites existing", () => {
    store.task.set("t1", makeTask({ id: "t1", status: "idle" }));
    store.task.set("t1", makeTask({ id: "t1", status: "done" }));
    expect(store.task.get("t1")?.status).toBe("done");
  });
});

describe("run CRUD", () => {
  beforeEach(() => {
    store.task.set("task-1", makeTask());
  });

  test("set and get", () => {
    const run = makeRun();
    store.run.set("task-1", run);
    expect(store.run.get(run.runId)).toEqual(run);
  });

  test("get missing returns undefined", () => {
    expect(store.run.get("nope")).toBeUndefined();
  });

  test("list returns runs for task", () => {
    store.run.set("task-1", makeRun({ runId: "r1", idempotencyKey: "ik1" }));
    store.run.set("task-1", makeRun({ runId: "r2", idempotencyKey: "ik2" }));
    expect(store.run.list("task-1")).toHaveLength(2);
  });

  test("list returns empty for unknown task", () => {
    expect(store.run.list("ghost")).toHaveLength(0);
  });

  test("list sortBy scheduledAt asc", () => {
    const t = Date.now();
    store.run.set("task-1", makeRun({ runId: "r1", idempotencyKey: "ik1", scheduledAt: t + 100 }));
    store.run.set("task-1", makeRun({ runId: "r2", idempotencyKey: "ik2", scheduledAt: t }));
    const runs = store.run.list("task-1", { sortBy: "scheduledAt", sortOrder: "asc" });
    expect(runs[0].runId).toBe("r2");
    expect(runs[1].runId).toBe("r1");
  });

  test("list with limit and offset", () => {
    for (let i = 0; i < 5; i++) {
      store.run.set("task-1", makeRun({ runId: `r${i}`, idempotencyKey: `ik${i}` }));
    }
    const page = store.run.list("task-1", { limit: 2, offset: 1 });
    expect(page).toHaveLength(2);
  });

  test("remove returns true if existed", () => {
    store.run.set("task-1", makeRun());
    expect(store.run.remove("run-1")).toBe(true);
    expect(store.run.get("run-1")).toBeUndefined();
  });

  test("remove returns false if missing", () => {
    expect(store.run.remove("ghost")).toBe(false);
  });

  test("status update overwrites", () => {
    store.run.set("task-1", makeRun({ status: "scheduled" }));
    store.run.set("task-1", makeRun({ status: "running" }));
    expect(store.run.get("run-1")?.status).toBe("running");
  });
});

describe("listByStatus", () => {
  beforeEach(() => {
    store.task.set("task-1", makeTask());
    store.run.set("task-1", makeRun({ runId: "r1", idempotencyKey: "ik1", status: "scheduled" }));
    store.run.set("task-1", makeRun({ runId: "r2", idempotencyKey: "ik2", status: "running" }));
    store.run.set("task-1", makeRun({ runId: "r3", idempotencyKey: "ik3", status: "done" }));
  });

  test("single status", () => {
    expect(store.run.listByStatus(["scheduled"])).toHaveLength(1);
  });

  test("multiple statuses", () => {
    expect(store.run.listByStatus(["scheduled", "running"])).toHaveLength(2);
  });

  test("empty statuses returns empty", () => {
    expect(store.run.listByStatus([])).toHaveLength(0);
  });
});

describe("idempotency", () => {
  beforeEach(() => {
    store.task.set("task-1", makeTask());
  });

  test("getByIdempotencyKey returns run", () => {
    store.run.set("task-1", makeRun({ idempotencyKey: "unique-key" }));
    const run = store.run.getByIdempotencyKey("unique-key");
    expect(run?.runId).toBe("run-1");
  });

  test("getByIdempotencyKey returns undefined for unknown key", () => {
    expect(store.run.getByIdempotencyKey("ghost")).toBeUndefined();
  });

  test("upsert with same key updates run_id", () => {
    store.run.set("task-1", makeRun({ runId: "r1", idempotencyKey: "k1" }));
    store.run.set("task-1", makeRun({ runId: "r2", idempotencyKey: "k1" }));
    const found = store.run.getByIdempotencyKey("k1");
    expect(found?.runId).toBe("r2");
  });

  test("idempotency entry removed when run is deleted", () => {
    store.run.set("task-1", makeRun({ idempotencyKey: "k1" }));
    store.run.remove("run-1");
    expect(store.run.getByIdempotencyKey("k1")).toBeUndefined();
  });
});

describe("FK CASCADE", () => {
  test("delete task removes all its runs", () => {
    store.task.set("task-1", makeTask());
    store.run.set("task-1", makeRun({ runId: "r1", idempotencyKey: "ik1" }));
    store.run.set("task-1", makeRun({ runId: "r2", idempotencyKey: "ik2" }));

    store.task.remove("task-1");

    expect(store.run.get("r1")).toBeUndefined();
    expect(store.run.get("r2")).toBeUndefined();
    expect(store.run.getByIdempotencyKey("ik1")).toBeUndefined();
    expect(store.run.getByIdempotencyKey("ik2")).toBeUndefined();
  });
});

describe("clear", () => {
  test("removes all data", () => {
    store.task.set("t1", makeTask({ id: "t1" }));
    store.task.set("t2", makeTask({ id: "t2" }));
    store.run.set("t1", makeRun({ runId: "r1", idempotencyKey: "ik1" }));
    store.clear();
    expect(store.task.list()).toHaveLength(0);
    expect(store.run.list("t1")).toHaveLength(0);
  });
});

describe("persistence", () => {
  test("data survives store re-open", () => {
    store.task.set("t1", makeTask({ id: "t1", title: "Persisted Task" }));
    store.run.set("t1", makeRun({ runId: "r1", idempotencyKey: "ik1" }));
    store.close();

    const store2 = new SqliteTaskStore(dbPath);
    expect(store2.task.get("t1")?.title).toBe("Persisted Task");
    expect(store2.run.get("r1")?.runId).toBe("r1");
    store2.close();

    store = new SqliteTaskStore(dbPath);
  });
});

describe("migration script", () => {
  test("migrates JSON files to SQLite", async () => {
    const srcDir = join(tmpdir(), `migrate-src-${Date.now()}`);
    mkdirSync(srcDir, { recursive: true });

    const task: Task.Info = makeTask({ id: "mt1", title: "Migrated" });
    const run: Task.Run = makeRun({ runId: "mr1", taskId: "mt1", idempotencyKey: "mik1" });

    writeFileSync(join(srcDir, "tasks.json"), JSON.stringify({ mt1: task }));
    writeFileSync(join(srcDir, "runs.json"), JSON.stringify({ mr1: run }));
    writeFileSync(join(srcDir, "taskRuns.json"), JSON.stringify({ mt1: ["mr1"] }));
    writeFileSync(join(srcDir, "idempotencyIndex.json"), JSON.stringify({ mik1: "mr1" }));

    const targetDb = join(srcDir, "tasks.db");
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(import.meta.dir, "../../../../scripts/migrate-tasks-to-sqlite.ts"),
        srcDir,
        targetDb,
      ],
      { stdout: "inherit", stderr: "inherit" },
    );
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    const migrated = new SqliteTaskStore(targetDb);
    expect(migrated.task.get("mt1")?.title).toBe("Migrated");
    expect(migrated.run.get("mr1")?.runId).toBe("mr1");
    expect(migrated.run.getByIdempotencyKey("mik1")?.runId).toBe("mr1");
    migrated.close();

    rmSync(srcDir, { recursive: true, force: true });
  });

  test("migration is idempotent (second run skips existing rows)", async () => {
    const srcDir = join(tmpdir(), `migrate-idem-${Date.now()}`);
    mkdirSync(srcDir, { recursive: true });

    const task: Task.Info = makeTask({ id: "mt2" });
    writeFileSync(join(srcDir, "tasks.json"), JSON.stringify({ mt2: task }));
    writeFileSync(join(srcDir, "runs.json"), JSON.stringify({}));
    writeFileSync(join(srcDir, "idempotencyIndex.json"), JSON.stringify({}));

    const targetDb = join(srcDir, "tasks.db");
    const scriptPath = join(import.meta.dir, "../../../../scripts/migrate-tasks-to-sqlite.ts");

    const run1 = Bun.spawn(["bun", "run", scriptPath, srcDir, targetDb], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await run1.exited;
    const run2 = Bun.spawn(["bun", "run", scriptPath, srcDir, targetDb], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await run2.exited;
    expect(run2.exitCode).toBe(0);

    const migrated = new SqliteTaskStore(targetDb);
    expect(migrated.task.list()).toHaveLength(1);
    migrated.close();

    rmSync(srcDir, { recursive: true, force: true });
  });
});
