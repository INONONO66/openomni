import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentInput } from "@openomni/agent";
import { Subagent } from "@openomni/protocol";
import { Bus, Storage } from "@openomni/session";
import { BackgroundManager } from "../../src/subagent/background-manager";
import { SubagentRuntime } from "../../src/subagent/runtime";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAgentResult(text: string): AgentResult {
  return {
    text,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  };
}

let createSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  Storage.reset();
  Bus.reset();
});

afterEach(() => {
  createSpy?.mockRestore();
  Bus.reset();
});

describe("BackgroundManager.create()", () => {
  it("returns instance with expected methods and default config", () => {
    const manager = BackgroundManager.create();

    expect(typeof manager.launch).toBe("function");
    expect(typeof manager.getTask).toBe("function");
    expect(typeof manager.getResult).toBe("function");
    expect(typeof manager.cancel).toBe("function");
    expect(typeof manager.listByParent).toBe("function");
    expect(typeof manager.cleanup).toBe("function");
    expect(typeof manager.stats).toBe("function");
    expect(typeof manager.dispose).toBe("function");

    manager.dispose();
  });
});

describe("BackgroundManager.launch()", () => {
  it("returns task with bg_ prefixed ID", async () => {
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => createAgentResult("done"),
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();

    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    expect(task.id).toStartWith("bg_");
  });

  it("returns task with pending or running status", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();

    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    expect(["pending", "running"]).toContain(task.status);

    deferred.resolve(createAgentResult("done"));
  });

  it("calls SubagentRuntime.spawnBackground() internally", async () => {
    const spawnSpy = spyOn(SubagentRuntime, "spawnBackground").mockResolvedValue({
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();

    await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    spawnSpy.mockRestore();
  });

  describe("concurrency limits", () => {
    it("returns error result when maxConcurrentPerAgent exceeded for same agent", async () => {
      const deferred = createDeferred<AgentResult>();
      createSpy = spyOn(ChatAgent, "create").mockImplementation(
        () =>
          ({
            run: async (_input: ChatAgentInput) => deferred.promise,
          }) as ReturnType<typeof ChatAgent.create>,
      );

      const parentSessionId = crypto.randomUUID();
      const manager = BackgroundManager.create({ maxConcurrentPerAgent: 1 });

      await manager.launch({ agentName: "worker", prompt: "first", model, parentSessionId });
      const second = await manager.launch({
        agentName: "worker",
        prompt: "second",
        model,
        parentSessionId,
      });

      expect(second.status).toBe("failed");
      expect(second.error).toBeDefined();

      deferred.resolve(createAgentResult("done"));
    });

    it("queues task when maxConcurrentTotal exceeded", async () => {
      const deferred = createDeferred<AgentResult>();
      createSpy = spyOn(ChatAgent, "create").mockImplementation(
        () =>
          ({
            run: async (_input: ChatAgentInput) => deferred.promise,
          }) as ReturnType<typeof ChatAgent.create>,
      );

      const parentSessionId = crypto.randomUUID();
      const manager = BackgroundManager.create({ maxConcurrentTotal: 1 });

      await manager.launch({ agentName: "worker-a", prompt: "first", model, parentSessionId });
      const second = await manager.launch({
        agentName: "worker-b",
        prompt: "second",
        model,
        parentSessionId,
      });

      expect(second.status).toBe("pending");

      deferred.resolve(createAgentResult("done"));
      manager.dispose();
    });

    it("returns error result when depth exceeds maxDepth", async () => {
      const parentSessionId = crypto.randomUUID();
      const manager = BackgroundManager.create({ maxDepth: 0 });

      const task = await manager.launch({
        agentName: "worker",
        prompt: "nested task",
        model,
        parentSessionId,
        depth: 1,
      });

      expect(task.status).toBe("failed");
      expect(task.error).toBeDefined();
    });

    it("returns error result when maxDescendants exceeded from same parent", async () => {
      const deferred = createDeferred<AgentResult>();
      createSpy = spyOn(ChatAgent, "create").mockImplementation(
        () =>
          ({
            run: async (_input: ChatAgentInput) => deferred.promise,
          }) as ReturnType<typeof ChatAgent.create>,
      );

      const parentSessionId = crypto.randomUUID();
      const manager = BackgroundManager.create({ maxDescendants: 1 });

      await manager.launch({ agentName: "worker", prompt: "first", model, parentSessionId });
      const second = await manager.launch({
        agentName: "worker",
        prompt: "second",
        model,
        parentSessionId,
      });

      expect(second.status).toBe("failed");
      expect(second.error).toBeDefined();

      deferred.resolve(createAgentResult("done"));
    });
  });
});

describe("BackgroundManager.getTask()", () => {
  it("returns the task after launch", async () => {
    const spawnSpy = spyOn(SubagentRuntime, "spawnBackground").mockResolvedValue({
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();
    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    const found = manager.getTask(task.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(task.id);

    spawnSpy.mockRestore();
  });

  it("returns undefined for nonexistent taskId", () => {
    const manager = BackgroundManager.create();
    expect(manager.getTask("nonexistent")).toBeUndefined();
  });
});

describe("BackgroundManager.getResult()", () => {
  it("returns undefined while task is running", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();
    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    expect(manager.getResult(task.id)).toBeUndefined();

    deferred.resolve(createAgentResult("done"));
  });

  it("returns result after task completes", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();
    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    deferred.resolve(createAgentResult("task output"));
    await new Promise((r) => setTimeout(r, 50));

    const result = manager.getResult(task.id);
    expect(result).toBeDefined();
    expect(result?.taskId).toBe(task.id);
    expect(result?.status).toBe("completed");
  });
});

describe("BackgroundManager.cancel()", () => {
  it("returns true and transitions task to cancelled", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();
    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    const cancelled = await manager.cancel(task.id);
    expect(cancelled).toBe(true);

    const updated = manager.getTask(task.id);
    expect(updated?.status).toBe("cancelled");
  });

  it("returns false for nonexistent taskId", async () => {
    const manager = BackgroundManager.create();
    const result = await manager.cancel("nonexistent");
    expect(result).toBe(false);
  });
});

describe("BackgroundManager.listByParent()", () => {
  it("returns only tasks with matching parentSessionId", async () => {
    const spawnSpy = spyOn(SubagentRuntime, "spawnBackground").mockResolvedValue({
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });

    const parentA = crypto.randomUUID();
    const parentB = crypto.randomUUID();
    const manager = BackgroundManager.create();

    await manager.launch({
      agentName: "worker",
      prompt: "task 1",
      model,
      parentSessionId: parentA,
    });
    await manager.launch({
      agentName: "worker",
      prompt: "task 2",
      model,
      parentSessionId: parentA,
    });
    await manager.launch({
      agentName: "worker",
      prompt: "task 3",
      model,
      parentSessionId: parentB,
    });

    const tasksA = manager.listByParent(parentA);
    const tasksB = manager.listByParent(parentB);

    expect(tasksA).toHaveLength(2);
    expect(tasksA.every((t) => t.parentSessionId === parentA)).toBe(true);
    expect(tasksB).toHaveLength(1);
    expect(tasksB[0].parentSessionId).toBe(parentB);

    spawnSpy.mockRestore();
  });
});

describe("BackgroundManager.cleanup()", () => {
  it("removes tasks with completedAt older than taskTtlMs", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create({ taskTtlMs: 1 });
    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    deferred.resolve(createAgentResult("done"));
    await new Promise((r) => setTimeout(r, 50));

    manager.cleanup();
    expect(manager.getTask(task.id)).toBeUndefined();
    expect(manager.getResult(task.id)).toBeUndefined();
  });
});

describe("onTaskComplete callback", () => {
  it("fires when task completes", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const completedResults: Subagent.BackgroundTaskResult[] = [];
    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create({
      onTaskComplete: (result) => completedResults.push(result),
    });

    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });
    deferred.resolve(createAgentResult("task output"));
    await new Promise((r) => setTimeout(r, 50));

    expect(completedResults).toHaveLength(1);
    expect(completedResults[0].taskId).toBe(task.id);
    expect(completedResults[0].status).toBe("completed");
  });
});

describe("BusEvents", () => {
  it("publishes BackgroundTaskLaunched on launch", async () => {
    const spawnSpy = spyOn(SubagentRuntime, "spawnBackground").mockResolvedValue({
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });

    const launchedEvents: Array<{ taskId: string; agentName: string; parentSessionId: string }> =
      [];
    const unsubscribe = Bus.subscribe(Subagent.Events.BackgroundTaskLaunched, (event: unknown) => {
      launchedEvents.push(
        (event as { payload: { taskId: string; agentName: string; parentSessionId: string } })
          .payload,
      );
    });

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();
    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    expect(launchedEvents).toHaveLength(1);
    expect(launchedEvents[0].taskId).toBe(task.id);
    expect(launchedEvents[0].agentName).toBe("worker");
    expect(launchedEvents[0].parentSessionId).toBe(parentSessionId);

    unsubscribe();
    spawnSpy.mockRestore();
  });

  it("publishes BackgroundTaskCompleted on completion", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const completedEvents: Array<{ taskId: string; status: string }> = [];
    const unsubscribe = Bus.subscribe(Subagent.Events.BackgroundTaskCompleted, (event: unknown) => {
      completedEvents.push((event as { payload: { taskId: string; status: string } }).payload);
    });

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();
    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    deferred.resolve(createAgentResult("output"));
    await new Promise((r) => setTimeout(r, 50));

    expect(completedEvents.some((e) => e.taskId === task.id)).toBe(true);
    const taskEvent = completedEvents.find((e) => e.taskId === task.id);
    expect(taskEvent?.status).toBe("completed");

    unsubscribe();
  });

  it("publishes BackgroundTaskFailed on failure", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const failedEvents: Array<{ taskId: string; error?: string }> = [];
    const unsubscribe = Bus.subscribe(Subagent.Events.BackgroundTaskFailed, (event: unknown) => {
      failedEvents.push((event as { payload: { taskId: string; error?: string } }).payload);
    });

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();
    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    deferred.reject(new Error("agent boom"));
    await new Promise((r) => setTimeout(r, 50));

    expect(failedEvents.some((e) => e.taskId === task.id)).toBe(true);

    unsubscribe();
  });

  it("publishes BackgroundTaskCancelled on cancel", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const cancelledEvents: Array<{ taskId: string }> = [];
    const unsubscribe = Bus.subscribe(Subagent.Events.BackgroundTaskCancelled, (event: unknown) => {
      cancelledEvents.push((event as { payload: { taskId: string } }).payload);
    });

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();
    const task = await manager.launch({
      agentName: "worker",
      prompt: "do work",
      model,
      parentSessionId,
    });

    await manager.cancel(task.id);
    await new Promise((r) => setTimeout(r, 10));

    expect(cancelledEvents.some((e) => e.taskId === task.id)).toBe(true);

    unsubscribe();
  });
});
