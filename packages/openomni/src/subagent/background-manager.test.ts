import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PolicyDecision, PolicyEvent } from "@openomni/protocol";
import { SqliteStorageAdapter } from "@openomni/session/src/storage/sqlite-storage";
import { Bus, Storage } from "@openomni/session";
import { BackgroundStore } from "./background-store";
import { BackgroundManager } from "./background-manager";
import { BackgroundLimitsMiddleware } from "./middleware/background-limits";
import { SubagentRuntime } from "./runtime";

let spawnBackgroundSpy: ReturnType<typeof spyOn> | undefined;
let cancelSpy: ReturnType<typeof spyOn> | undefined;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

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

function createDeferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => {
    throw new Error("deferred resolve called before initialization");
  };
  let reject: Deferred<T>["reject"] = () => {
    throw new Error("deferred reject called before initialization");
  };
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  spawnBackgroundSpy?.mockRestore();
  spawnBackgroundSpy = undefined;
  cancelSpy?.mockRestore();
  cancelSpy = undefined;
  Bus.reset();
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

  it("passes resolved provider auth to background subagent runs", async () => {
    const manager = BackgroundManager.create({
      allowAuthFallback: false,
      resolveAuth: (provider) =>
        provider === "anthropic"
          ? { type: "proxy", baseURL: "http://localhost:8317/v1", apiKey: "proxy" }
          : undefined,
    });
    try {
      const task = await manager.launch({
        ...makeLaunchInput(),
        model: { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
      });

      expect(task.status).toBe("running");
      expect(spawnBackgroundSpy).toHaveBeenCalledTimes(1);
      expect(spawnBackgroundSpy.mock.calls[0]?.[0].auth).toEqual({
        type: "proxy",
        baseURL: "http://localhost:8317/v1",
        apiKey: "proxy",
      });
      expect(spawnBackgroundSpy.mock.calls[0]?.[0].allowAuthFallback).toBe(false);
      await manager.cancel(task.id);
    } finally {
      manager.dispose();
    }
  });

  it("cleans up active state when auth resolution fails", async () => {
    const manager = BackgroundManager.create({
      resolveAuth: () => {
        throw new Error("auth unavailable");
      },
    });
    try {
      const task = await manager.launch(makeLaunchInput());

      expect(task.status).toBe("failed");
      expect(task.error).toBe("auth unavailable");
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 1 });
      expect(spawnBackgroundSpy).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("preserves cancelled task state when spawn fails after cancellation", async () => {
    const deferred = createDeferred<{ sessionId: string; runId: string }>();
    spawnBackgroundSpy?.mockRestore();
    spawnBackgroundSpy = spyOn(SubagentRuntime, "spawnBackground").mockImplementation(
      () => deferred.promise,
    );
    const manager = BackgroundManager.create();

    try {
      const launchPromise = manager.launch(makeLaunchInput());
      await new Promise((resolve) => setTimeout(resolve, 0));

      const task = manager.listByParent("parent-session-1")[0];
      expect(task?.status).toBe("pending");
      expect(manager.stats()).toEqual({ active: 1, pending: 0, total: 1 });
      if (!task) throw new Error("expected launched task");

      await manager.cancel(task.id);
      expect(manager.getTask(task.id)?.status).toBe("cancelled");
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 1 });

      deferred.reject(new Error("spawn failed after cancel"));
      const result = await launchPromise;

      expect(result.status).toBe("cancelled");
      expect(result.error).toBeUndefined();
      expect(manager.getTask(task.id)?.status).toBe("cancelled");
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 1 });
    } finally {
      manager.dispose();
    }
  });

  it("does not resurrect a cleaned cancelled task when spawn fails late", async () => {
    const deferred = createDeferred<{ sessionId: string; runId: string }>();
    spawnBackgroundSpy?.mockRestore();
    spawnBackgroundSpy = spyOn(SubagentRuntime, "spawnBackground").mockImplementation(
      () => deferred.promise,
    );
    const manager = BackgroundManager.create({ taskTtlMs: 0 });

    try {
      const launchPromise = manager.launch(makeLaunchInput());
      await new Promise((resolve) => setTimeout(resolve, 0));

      const task = manager.listByParent("parent-session-1")[0];
      expect(task?.status).toBe("pending");
      if (!task) throw new Error("expected launched task");

      await manager.cancel(task.id);
      await new Promise((resolve) => setTimeout(resolve, 2));
      manager.cleanup();
      expect(manager.getTask(task.id)).toBeUndefined();
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 0 });

      deferred.reject(new Error("spawn failed after cleanup"));
      await launchPromise;

      expect(manager.getTask(task.id)).toBeUndefined();
      expect(manager.getResult(task.id)).toBeUndefined();
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 0 });
    } finally {
      manager.dispose();
    }
  });

  it("preserves cancelled task state when spawn resolves after cancellation", async () => {
    const deferred = createDeferred<{ sessionId: string; runId: string }>();
    spawnBackgroundSpy?.mockRestore();
    spawnBackgroundSpy = spyOn(SubagentRuntime, "spawnBackground").mockImplementation(
      () => deferred.promise,
    );
    cancelSpy = spyOn(SubagentRuntime, "cancel").mockResolvedValue();
    const manager = BackgroundManager.create();

    try {
      const launchPromise = manager.launch(makeLaunchInput());
      await new Promise((resolve) => setTimeout(resolve, 0));

      const task = manager.listByParent("parent-session-1")[0];
      expect(task?.status).toBe("pending");
      expect(manager.stats()).toEqual({ active: 1, pending: 0, total: 1 });
      if (!task) throw new Error("expected launched task");

      await manager.cancel(task.id);
      expect(manager.getTask(task.id)?.status).toBe("cancelled");
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 1 });

      deferred.resolve({ sessionId: "late-session", runId: "late-run" });
      const result = await launchPromise;

      expect(result.status).toBe("cancelled");
      expect(manager.getTask(task.id)?.status).toBe("cancelled");
      expect(manager.stats()).toEqual({ active: 0, pending: 0, total: 1 });
      expect(cancelSpy).toHaveBeenCalledWith({ sessionId: "late-session", runId: "late-run" });
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

    expect(result.verdict.verdict).toBe("deny");
    expect(result.verdict.policyId).toBe("agent.policy.composed");
    expect(PolicyDecision.reason(result.verdict)).toBe(
      "max concurrent tasks per agent (0) exceeded",
    );
  });

  it("emits durable audit events for background launch limits", async () => {
    const composed: Array<{
      action: string;
      resource: string;
      sessionId: string;
      pointId?: string;
      verdict: string;
    }> = [];
    const unsubscribe = Bus.subscribe(PolicyEvent.DecisionComposed, (event) => {
      composed.push(event);
    });

    await BackgroundLimitsMiddleware.evaluatePreLaunch({
      input: makeLaunchInput(),
      activeTasks: [],
      activeCount: 0,
      pendingQueueSize: 0,
      maxConcurrentPerAgent: 3,
      maxConcurrentTotal: 10,
      maxDepth: 5,
      maxDescendants: 10,
      maxQueueSize: 100,
    });
    unsubscribe();

    expect(composed).toHaveLength(1);
    expect(composed[0]).toMatchObject({
      action: "delegation.background.launch",
      resource: "agent.test-agent",
      sessionId: "parent-session-1",
      pointId: "delegation.background.pre",
      verdict: "allow",
    });
  });

  it("treats background launch deny verdict as terminal", async () => {
    const evaluateSpy = spyOn(BackgroundLimitsMiddleware, "evaluatePreLaunch").mockResolvedValue({
      verdict: PolicyDecision.deny({
        policyId: "test:deny-background-launch",
        reasonCodes: ["background launch denied by policy"],
      }),
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
      verdict: PolicyDecision.pending({
        policyId: "test:retry-background-launch",
        reasonCodes: ["retry is not supported for background launch"],
      }),
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
