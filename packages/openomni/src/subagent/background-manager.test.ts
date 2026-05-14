import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { SqliteStorageAdapter } from "@openomni/session/src/storage/sqlite-storage";
import { Storage } from "@openomni/session";
import { BackgroundStore } from "./background-store";
import { BackgroundManager } from "./background-manager";
import { BackgroundLimitsMiddleware } from "./middleware/background-limits";
import { SubagentRuntime } from "./runtime";

let spawnBackgroundSpy: ReturnType<typeof spyOn> | undefined;

function makeTask(id: string): import("@openomni/protocol").Subagent.BackgroundTask {
  return {
    id,
    agentName: "test-agent",
    prompt: "do something",
    status: "running",
    parentSessionId: "parent-session-1",
    sessionId: "worker-session-1",
    runId: "run-1",
    queuedAt: Date.now() - 5000,
    startedAt: Date.now() - 4000,
    depth: 0,
  };
}

function makeLaunchInput() {
  return {
    agentName: "test-agent",
    prompt: "do something",
    model: { provider: "test", id: "model" },
    parentSessionId: "parent-session-1",
  };
}

function configureMemoryStorage(): void {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Storage.configure(new SqliteStorageAdapter(":memory:"));
}

function mockSpawnBackground(): void {
  spawnBackgroundSpy = spyOn(SubagentRuntime, "spawnBackground").mockResolvedValue({
    sessionId: "worker-session-1",
    runId: "run-1",
  });
}

afterEach(() => {
  spawnBackgroundSpy?.mockRestore();
  spawnBackgroundSpy = undefined;
});

describe("BackgroundStore — SQLite persistence", () => {
  beforeEach(() => {
    configureMemoryStorage();
  });

  it("persists a running task and retrieves it", () => {
    const task = makeTask("bg_test01");
    BackgroundStore.persist(task);

    const found = BackgroundStore.getTask("bg_test01");
    expect(found).toBeDefined();
    expect(found?.id).toBe("bg_test01");
    expect(found?.status).toBe("running");
    expect(found?.agentName).toBe("test-agent");
  });

  it("persists completed task output and retrieves it via getResult", () => {
    const task = {
      ...makeTask("bg_test02"),
      status: "completed" as const,
      completedAt: Date.now(),
    };
    BackgroundStore.persist(task, "the model output");

    const result = BackgroundStore.getResult("bg_test02");
    expect(result).toBeDefined();
    expect(result?.status).toBe("completed");
    expect(result?.output).toBe("the model output");
  });

  it("loadInterrupted marks running tasks as failed with worker restarted error", () => {
    BackgroundStore.persist(makeTask("bg_int01"));
    BackgroundStore.persist(makeTask("bg_int02"));

    const interrupted = BackgroundStore.loadInterrupted();
    expect(interrupted).toHaveLength(2);
    for (const t of interrupted) {
      expect(t.status).toBe("failed");
      expect(t.error).toBe("worker restarted");
    }
  });

  it("loadInterrupted does not return already-terminal tasks", () => {
    const completed = {
      ...makeTask("bg_done"),
      status: "completed" as const,
      completedAt: Date.now(),
    };
    BackgroundStore.persist(completed, "output");
    BackgroundStore.persist(makeTask("bg_running"));

    const interrupted = BackgroundStore.loadInterrupted();
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.id).toBe("bg_running");
  });

  it("getResult returns undefined for tasks still in running state", () => {
    BackgroundStore.persist(makeTask("bg_still_running"));
    expect(BackgroundStore.getResult("bg_still_running")).toBeUndefined();
  });
});

describe("BackgroundManager — task survives recreation", () => {
  beforeEach(() => {
    configureMemoryStorage();
  });

  it("getTask returns interrupted task after manager is recreated", () => {
    const task = makeTask("bg_crash01");
    BackgroundStore.persist(task);

    // Simulate worker restart: new manager loads from DB
    const manager = BackgroundManager.create();
    manager.dispose();

    const found = manager.getTask("bg_crash01");
    expect(found).toBeDefined();
    expect(found?.status).toBe("failed");
    expect(found?.error).toBe("worker restarted");
  });

  it("getResult returns failed result for interrupted task after recreation", () => {
    BackgroundStore.persist(makeTask("bg_crash02"));

    const manager = BackgroundManager.create();
    manager.dispose();

    const result = manager.getResult("bg_crash02");
    expect(result).toBeDefined();
    expect(result?.status).toBe("failed");
  });
});

describe("BackgroundManager — launch limit policy", () => {
  beforeEach(() => {
    configureMemoryStorage();
    mockSpawnBackground();
  });

  it("rejects per-agent limit before task insertion", async () => {
    const manager = BackgroundManager.create({ maxConcurrentPerAgent: 0 });
    try {
      const task = await manager.launch(makeLaunchInput());

      expect(task.status).toBe("failed");
      expect(task.error).toBe("max concurrent tasks per agent (0) exceeded");
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 0 });
      expect(spawnBackgroundSpy).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("rejects depth limit before task insertion", async () => {
    const manager = BackgroundManager.create({ maxDepth: 0 });
    try {
      const task = await manager.launch({ ...makeLaunchInput(), depth: 1 });

      expect(task.status).toBe("failed");
      expect(task.error).toBe("max depth (0) exceeded");
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 0 });
      expect(spawnBackgroundSpy).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("rejects descendant limit before task insertion", async () => {
    const manager = BackgroundManager.create({ maxDescendants: 0 });
    try {
      const task = await manager.launch(makeLaunchInput());

      expect(task.status).toBe("failed");
      expect(task.error).toBe("max descendants (0) from same parent exceeded");
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 0 });
      expect(spawnBackgroundSpy).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("queues when total concurrency is saturated", async () => {
    const manager = BackgroundManager.create({ maxConcurrentTotal: 0, maxQueueSize: 1 });
    try {
      const task = await manager.launch(makeLaunchInput());

      expect(task.status).toBe("pending");
      expect(manager.stats()).toEqual({ active: 0, pending: 1, total: 1 });
      expect(spawnBackgroundSpy).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("rejects queue limit without mutating task state", async () => {
    const manager = BackgroundManager.create({ maxConcurrentTotal: 0, maxQueueSize: 1 });
    try {
      const first = await manager.launch(makeLaunchInput());
      const second = await manager.launch({
        ...makeLaunchInput(),
        parentSessionId: "parent-session-2",
      });

      expect(first.status).toBe("pending");
      expect(second.status).toBe("failed");
      expect(second.error).toBe("queue full (max 1)");
      expect(manager.stats()).toEqual({ active: 0, pending: 1, total: 1 });
      expect(spawnBackgroundSpy).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("preserves valid launch behavior", async () => {
    const manager = BackgroundManager.create();
    try {
      const task = await manager.launch(makeLaunchInput());

      expect(task.status).toBe("running");
      expect(task.sessionId).toBe("worker-session-1");
      expect(task.runId).toBe("run-1");
      expect(manager.stats()).toEqual({ active: 1, pending: 0, total: 1 });
      expect(spawnBackgroundSpy).toHaveBeenCalledTimes(1);
      await manager.cancel(task.id);
    } finally {
      manager.dispose();
    }
  });

  it("returns policy metadata on non-continue verdicts", async () => {
    const result = await BackgroundLimitsMiddleware.evaluatePreLaunch({
      input: makeLaunchInput(),
      activeTasks: [],
      activeCount: 0,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 0,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 10,
      maxQueueSize: 100,
    });

    expect(result.verdict.action).toBe("abort");
    expect(result.verdict.policyId).toBe("guardrail.permission");
    expect(result.verdict.reason).toBe("max concurrent tasks per agent (0) exceeded");
  });

  it("treats background launch deny verdict as terminal", async () => {
    const evaluateSpy = spyOn(BackgroundLimitsMiddleware, "evaluatePreLaunch").mockResolvedValue({
      verdict: {
        action: "deny",
        reason: "background launch denied by policy",
        policyId: "test:deny-background-launch",
      },
      shouldQueue: false,
    });
    const manager = BackgroundManager.create();

    try {
      const task = await manager.launch(makeLaunchInput());

      expect(task.status).toBe("failed");
      expect(task.error).toBe("background launch denied by policy");
      expect(spawnBackgroundSpy).not.toHaveBeenCalled();
    } finally {
      evaluateSpy.mockRestore();
      manager.dispose();
    }
  });

  it("fails closed when background launch returns an unsupported verdict", async () => {
    const evaluateSpy = spyOn(BackgroundLimitsMiddleware, "evaluatePreLaunch").mockResolvedValue({
      verdict: {
        action: "retry",
        reason: "retry is not supported for background launch",
        policyId: "test:retry-background-launch",
      },
      shouldQueue: false,
    });
    const manager = BackgroundManager.create();

    try {
      const task = await manager.launch(makeLaunchInput());

      expect(task.status).toBe("failed");
      expect(task.error).toBe("retry is not supported for background launch");
      expect(spawnBackgroundSpy).not.toHaveBeenCalled();
    } finally {
      evaluateSpy.mockRestore();
      manager.dispose();
    }
  });
});
