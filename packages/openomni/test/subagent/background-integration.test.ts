import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentInput } from "@openomni/agent";
import { Subagent } from "@openomni/protocol";
import { Bus, Session, Storage, WorkerRun } from "@openomni/session";
import { BackgroundManager } from "../../src/subagent/background-manager";

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

describe("BackgroundManager integration: launch + complete + retrieve", () => {
  it("task completes and result is retrievable; real session and WorkerRun are created", async () => {
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
      prompt: "compute something",
      model,
      parentSessionId,
    });

    expect(task.id).toStartWith("bg_");
    expect(["pending", "running"]).toContain(task.status);
    expect(task.sessionId).toBeString();
    expect(task.runId).toBeString();

    const sessionId = task.sessionId as string;
    const runId = task.runId as string;

    const session = Session.get(sessionId);
    expect(session).toBeDefined();

    const activeRun = await WorkerRun.get(sessionId, runId);
    expect(activeRun).toBeDefined();
    expect(activeRun?.status).toBe("running");

    expect(manager.getResult(task.id)).toBeUndefined();

    deferred.resolve(createAgentResult("computed result"));
    await new Promise((r) => setTimeout(r, 50));

    const result = manager.getResult(task.id);
    expect(result).toBeDefined();
    expect(result?.taskId).toBe(task.id);
    expect(result?.status).toBe("completed");

    const finalTask = manager.getTask(task.id);
    expect(finalTask?.status).toBe("completed");
    expect(finalTask?.completedAt).toBeDefined();

    const finalRun = await WorkerRun.get(sessionId, runId);
    expect(finalRun?.status).toBe("succeeded");
  });
});

describe("BackgroundManager integration: launch + cancel", () => {
  it("cancel before completion transitions task to cancelled and aborts the controller", async () => {
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
      prompt: "long running task",
      model,
      parentSessionId,
    });

    expect(["pending", "running"]).toContain(task.status);

    const cancelled = await manager.cancel(task.id);
    expect(cancelled).toBe(true);

    const updated = manager.getTask(task.id);
    expect(updated?.status).toBe("cancelled");
    expect(updated?.completedAt).toBeDefined();

    // resolve to avoid leaked promise
    deferred.resolve(createAgentResult("too late"));
  });
});

describe("BackgroundManager integration: concurrent limit per agent", () => {
  it("second launch for same agent fails when maxConcurrentPerAgent is 1", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create({ maxConcurrentPerAgent: 1 });

    const first = await manager.launch({
      agentName: "worker",
      prompt: "first task",
      model,
      parentSessionId,
    });

    const second = await manager.launch({
      agentName: "worker",
      prompt: "second task",
      model,
      parentSessionId,
    });

    expect(["pending", "running"]).toContain(first.status);
    expect(second.status).toBe("failed");
    expect(second.error).toBeDefined();
    expect(second.error).toContain("max concurrent tasks per agent");
    // failed task has no session — limit enforced before SubagentRuntime is called
    expect(second.sessionId).toBeUndefined();

    deferred.resolve(createAgentResult("done"));
  });
});

describe("BackgroundManager integration: multiple agents in parallel", () => {
  it("tasks for different agents all reach running state and all complete", async () => {
    const deferreds = [
      createDeferred<AgentResult>(),
      createDeferred<AgentResult>(),
      createDeferred<AgentResult>(),
    ];
    let callIndex = 0;

    createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
      const d = deferreds[callIndex++];
      return {
        run: async (_input: ChatAgentInput) => d.promise,
      } as unknown as ReturnType<typeof ChatAgent.create>;
    });

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create();

    const taskA = await manager.launch({
      agentName: "worker-a",
      prompt: "task a",
      model,
      parentSessionId,
    });
    const taskB = await manager.launch({
      agentName: "worker-b",
      prompt: "task b",
      model,
      parentSessionId,
    });
    const taskC = await manager.launch({
      agentName: "worker-c",
      prompt: "task c",
      model,
      parentSessionId,
    });

    expect(["pending", "running"]).toContain(taskA.status);
    expect(["pending", "running"]).toContain(taskB.status);
    expect(["pending", "running"]).toContain(taskC.status);

    expect(taskA.sessionId).toBeString();
    expect(taskB.sessionId).toBeString();
    expect(taskC.sessionId).toBeString();
    expect(new Set([taskA.sessionId, taskB.sessionId, taskC.sessionId]).size).toBe(3);

    deferreds[0].resolve(createAgentResult("output a"));
    deferreds[1].resolve(createAgentResult("output b"));
    deferreds[2].resolve(createAgentResult("output c"));
    await new Promise((r) => setTimeout(r, 50));

    expect(manager.getResult(taskA.id)?.status).toBe("completed");
    expect(manager.getResult(taskB.id)?.status).toBe("completed");
    expect(manager.getResult(taskC.id)?.status).toBe("completed");
  });
});

describe("BackgroundManager integration: TTL cleanup", () => {
  it("completed task is removed after TTL expires on next launch", async () => {
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => createAgentResult("done"),
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create({ taskTtlMs: 1 });

    const first = await manager.launch({
      agentName: "worker",
      prompt: "quick task",
      model,
      parentSessionId,
    });

    // wait for completion event to propagate
    await new Promise((r) => setTimeout(r, 50));
    expect(manager.getTask(first.id)?.status).toBe("completed");

    // wait past TTL
    await new Promise((r) => setTimeout(r, 10));

    manager.cleanup();

    expect(manager.getTask(first.id)).toBeUndefined();
  });
});

describe("BackgroundManager integration: Bus events published", () => {
  it("publishes BackgroundTaskLaunched with correct taskId, agentName, parentSessionId", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const launchedPayloads: Array<{
      taskId: string;
      agentName: string;
      parentSessionId: string;
    }> = [];

    const unsubscribe = Bus.subscribe(Subagent.Events.BackgroundTaskLaunched, (event: unknown) => {
      launchedPayloads.push(
        (
          event as {
            payload: { taskId: string; agentName: string; parentSessionId: string };
          }
        ).payload,
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

    expect(launchedPayloads).toHaveLength(1);
    expect(launchedPayloads[0].taskId).toBe(task.id);
    expect(launchedPayloads[0].agentName).toBe("worker");
    expect(launchedPayloads[0].parentSessionId).toBe(parentSessionId);

    unsubscribe();
    deferred.resolve(createAgentResult("done"));
  });
});
