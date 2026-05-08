import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, Todo } from "@openomni/protocol";
import type { SessionInfo } from "../../src/session/info";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";

function makeSession(id: string): SessionInfo {
  const now = Date.now();
  return {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test" },
    time: { created: now, updated: now },
    spawnDepth: 0,
  };
}

function tempDbPath(): string {
  return join(tmpdir(), `test-sqlite-ext-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeTask(id: string, overrides: Partial<Task.Info> = {}): Task.Info {
  return {
    id,
    title: `Task ${id}`,
    owner: { type: "user", id: "user-1" },
    status: "idle",
    tags: ["test"],
    ...overrides,
  };
}

function makeRun(runId: string, taskId: string, overrides: Partial<Task.Run> = {}): Task.Run {
  return {
    runId,
    taskId,
    sessionKey: `session-${runId}`,
    status: "scheduled",
    trigger: { id: "t1", type: "manual" },
    idempotencyKey: `idem-${runId}`,
    scheduledAt: Date.now(),
    attempt: 1,
    ...overrides,
  };
}

function makeTodo(id: string, sessionId: string, position: number): Todo.Info {
  return {
    id,
    sessionId,
    content: `Todo ${id}`,
    status: "pending",
    priority: "medium",
    position,
  };
}

describe("SqliteStorageAdapter — task sub-adapter", () => {
  let dbPath = "";
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = tempDbPath();
    adapter = new SqliteStorageAdapter(dbPath);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch (_) {
      void _;
    }
    try {
      unlinkSync(dbPath);
    } catch (_) {
      void _;
    }
  });

  describe("task", () => {
    test("get: returns undefined for non-existent", () => {
      expect(adapter.task?.task.get("missing")).toBeUndefined();
    });

    test("set and get: roundtrip", () => {
      const t = makeTask("task-1");
      adapter.task?.task.set("task-1", t);
      expect(adapter.task?.task.get("task-1")).toEqual(t);
    });

    test("set: upsert overwrites existing", () => {
      const t = makeTask("task-1");
      adapter.task?.task.set("task-1", t);
      const updated: Task.Info = { ...t, title: "Updated", status: "scheduled" };
      adapter.task?.task.set("task-1", updated);
      expect(adapter.task?.task.get("task-1")).toEqual(updated);
    });

    test("list: returns empty initially", () => {
      expect(adapter.task?.task.list()).toEqual([]);
    });

    test("list: returns all tasks", () => {
      adapter.task?.task.set("t1", makeTask("t1"));
      adapter.task?.task.set("t2", makeTask("t2"));
      expect(adapter.task?.task.list()).toHaveLength(2);
    });

    test("list: filters by single status", () => {
      adapter.task?.task.set("t1", makeTask("t1", { status: "idle" }));
      adapter.task?.task.set("t2", makeTask("t2", { status: "running" }));
      const running = adapter.task?.task.list({ status: "running" });
      expect(running).toHaveLength(1);
      expect(running?.[0].id).toBe("t2");
    });

    test("list: filters by status array", () => {
      adapter.task?.task.set("t1", makeTask("t1", { status: "idle" }));
      adapter.task?.task.set("t2", makeTask("t2", { status: "running" }));
      adapter.task?.task.set("t3", makeTask("t3", { status: "done" }));
      const active = adapter.task?.task.list({ status: ["idle", "running"] });
      expect(active).toHaveLength(2);
    });

    test("list: filters by ownerId", () => {
      adapter.task?.task.set("t1", makeTask("t1", { owner: { type: "user", id: "alice" } }));
      adapter.task?.task.set("t2", makeTask("t2", { owner: { type: "user", id: "bob" } }));
      const aliceTasks = adapter.task?.task.list({ ownerId: "alice" });
      expect(aliceTasks).toHaveLength(1);
      expect(aliceTasks?.[0].id).toBe("t1");
    });

    test("list: filters by assignedAgentId", () => {
      adapter.task?.task.set("t1", makeTask("t1", { assignedAgentId: "agent-x" }));
      adapter.task?.task.set("t2", makeTask("t2"));
      const assigned = adapter.task?.task.list({ assignedAgentId: "agent-x" });
      expect(assigned).toHaveLength(1);
      expect(assigned?.[0].id).toBe("t1");
    });

    test("remove: deletes task and returns true", () => {
      adapter.task?.task.set("t1", makeTask("t1"));
      expect(adapter.task?.task.remove("t1")).toBe(true);
      expect(adapter.task?.task.get("t1")).toBeUndefined();
    });

    test("remove: returns false for non-existent", () => {
      expect(adapter.task?.task.remove("missing")).toBe(false);
    });

    test("remove: cascades to runs", () => {
      adapter.task?.task.set("t1", makeTask("t1"));
      adapter.task?.run.set("t1", makeRun("r1", "t1"));
      adapter.task?.task.remove("t1");
      expect(adapter.task?.run.get("r1")).toBeUndefined();
    });
  });

  describe("run", () => {
    beforeEach(() => {
      adapter.task?.task.set("t1", makeTask("t1"));
    });

    test("get: returns undefined for non-existent", () => {
      expect(adapter.task?.run.get("missing")).toBeUndefined();
    });

    test("set and get: roundtrip", () => {
      const run = makeRun("r1", "t1");
      adapter.task?.run.set("t1", run);
      expect(adapter.task?.run.get("r1")).toEqual(run);
    });

    test("set: upsert overwrites existing run", () => {
      const run = makeRun("r1", "t1");
      adapter.task?.run.set("t1", run);
      const updated = { ...run, status: "running" as const, startedAt: Date.now() };
      adapter.task?.run.set("t1", updated);
      expect(adapter.task?.run.get("r1")?.status).toBe("running");
    });

    test("list: returns runs for task", () => {
      adapter.task?.run.set("t1", makeRun("r1", "t1"));
      adapter.task?.run.set("t1", makeRun("r2", "t1", { idempotencyKey: "idem-r2" }));
      expect(adapter.task?.run.list("t1")).toHaveLength(2);
    });

    test("list: returns empty for task with no runs", () => {
      expect(adapter.task?.run.list("t1")).toEqual([]);
    });

    test("listByStatus: returns matching runs", () => {
      adapter.task?.run.set("t1", makeRun("r1", "t1", { status: "running" }));
      adapter.task?.run.set(
        "t1",
        makeRun("r2", "t1", { status: "done", idempotencyKey: "idem-r2" }),
      );
      const running = adapter.task?.run.listByStatus(["running"]);
      expect(running).toHaveLength(1);
      expect(running?.[0].runId).toBe("r1");
    });

    test("listByStatus: returns empty for empty statuses array", () => {
      adapter.task?.run.set("t1", makeRun("r1", "t1"));
      expect(adapter.task?.run.listByStatus([])).toEqual([]);
    });

    test("listByStatus: returns multiple status matches", () => {
      adapter.task?.run.set("t1", makeRun("r1", "t1", { status: "running" }));
      adapter.task?.run.set(
        "t1",
        makeRun("r2", "t1", { status: "done", idempotencyKey: "idem-r2" }),
      );
      const result = adapter.task?.run.listByStatus(["running", "done"]);
      expect(result).toHaveLength(2);
    });

    test("remove: deletes run and returns true", () => {
      adapter.task?.run.set("t1", makeRun("r1", "t1"));
      expect(adapter.task?.run.remove("r1")).toBe(true);
      expect(adapter.task?.run.get("r1")).toBeUndefined();
    });

    test("remove: returns false for non-existent", () => {
      expect(adapter.task?.run.remove("missing")).toBe(false);
    });

    test("getByIdempotencyKey: returns run by key", () => {
      const run = makeRun("r1", "t1");
      adapter.task?.run.set("t1", run);
      expect(adapter.task?.run.getByIdempotencyKey(run.idempotencyKey)).toEqual(run);
    });

    test("getByIdempotencyKey: returns undefined for unknown key", () => {
      expect(adapter.task?.run.getByIdempotencyKey("no-such-key")).toBeUndefined();
    });
  });
});

describe("SqliteStorageAdapter — todo sub-adapter", () => {
  let dbPath = "";
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    dbPath = tempDbPath();
    adapter = new SqliteStorageAdapter(dbPath);
    adapter.session.set("s1", makeSession("s1"));
    adapter.session.set("s2", makeSession("s2"));
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch (_) {
      void _;
    }
    try {
      unlinkSync(dbPath);
    } catch (_) {
      void _;
    }
  });

  test("list: returns empty for session with no todos", async () => {
    expect(await adapter.todo?.list("s1")).toEqual([]);
  });

  test("upsertAll and list: roundtrip", async () => {
    const todos = [makeTodo("todo-1", "s1", 0), makeTodo("todo-2", "s1", 1)];
    await adapter.todo?.upsertAll("s1", todos);
    const result = await adapter.todo?.list("s1");
    expect(result).toHaveLength(2);
    expect(result).toEqual(todos);
  });

  test("upsertAll: replaces existing todos (not appends)", async () => {
    await adapter.todo?.upsertAll("s1", [makeTodo("old-1", "s1", 0), makeTodo("old-2", "s1", 1)]);
    await adapter.todo?.upsertAll("s1", [makeTodo("new-1", "s1", 0)]);
    const result = await adapter.todo?.list("s1");
    expect(result).toHaveLength(1);
    expect(result?.[0].id).toBe("new-1");
  });

  test("upsertAll: only affects the given session", async () => {
    await adapter.todo?.upsertAll("s1", [makeTodo("t1", "s1", 0)]);
    await adapter.todo?.upsertAll("s2", [makeTodo("t2", "s2", 0)]);
    await adapter.todo?.upsertAll("s1", [makeTodo("t3", "s1", 0)]);
    expect(await adapter.todo?.list("s1")).toHaveLength(1);
    expect(await adapter.todo?.list("s2")).toHaveLength(1);
  });

  test("list: returns todos ordered by position ascending", async () => {
    const todos = [makeTodo("t3", "s1", 2), makeTodo("t1", "s1", 0), makeTodo("t2", "s1", 1)];
    await adapter.todo?.upsertAll("s1", todos);
    const result = await adapter.todo?.list("s1");
    expect(result?.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  test("deleteAll: removes all todos for session", async () => {
    await adapter.todo?.upsertAll("s1", [makeTodo("t1", "s1", 0), makeTodo("t2", "s1", 1)]);
    await adapter.todo?.deleteAll("s1");
    expect(await adapter.todo?.list("s1")).toEqual([]);
  });

  test("deleteAll: only affects given session", async () => {
    await adapter.todo?.upsertAll("s1", [makeTodo("t1", "s1", 0)]);
    await adapter.todo?.upsertAll("s2", [makeTodo("t2", "s2", 0)]);
    await adapter.todo?.deleteAll("s1");
    expect(await adapter.todo?.list("s2")).toHaveLength(1);
  });

  test("upsertAll: empty array clears todos", async () => {
    await adapter.todo?.upsertAll("s1", [makeTodo("t1", "s1", 0)]);
    await adapter.todo?.upsertAll("s1", []);
    expect(await adapter.todo?.list("s1")).toEqual([]);
  });

  test("todo fields are preserved on roundtrip", async () => {
    const todo: Todo.Info = {
      id: "t1",
      sessionId: "s1",
      content: "Do something important",
      status: "in_progress",
      priority: "high",
      position: 0,
    };
    await adapter.todo?.upsertAll("s1", [todo]);
    const result = await adapter.todo?.list("s1");
    expect(result?.[0]).toEqual(todo);
  });
});
