import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { type AgentResult, type ChatAgentInput, ChatAgent } from "@openomni/agent";
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

function makeAgentResult(text = "done"): AgentResult {
  return {
    text,
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    finishReason: "stop",
  };
}

let createSpy: ReturnType<typeof spyOn> | undefined;
let spawnSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  Storage.reset();
  Bus.reset();
});

afterEach(() => {
  createSpy?.mockRestore();
  spawnSpy?.mockRestore();
  Bus.reset();
});

describe("BackgroundManager bounded queue", () => {
  it("queues tasks when maxConcurrentTotal is exceeded", async () => {
    const deferreds = Array.from({ length: 20 }, () => createDeferred<AgentResult>());
    let callCount = 0;
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferreds[callCount++].promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create({
      maxConcurrentTotal: 5,
      maxConcurrentPerAgent: 20,
      maxDescendants: 20,
    });

    const tasks = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        manager.launch({
          agentName: "worker",
          prompt: `task ${i}`,
          model,
          parentSessionId,
        }),
      ),
    );

    await new Promise((r) => setTimeout(r, 20));

    const running = tasks.filter((t) => {
      const current = manager.getTask(t.id);
      return current?.status === "running";
    });
    const pending = tasks.filter((t) => {
      const current = manager.getTask(t.id);
      return current?.status === "pending";
    });

    expect(running.length).toBeLessThanOrEqual(5);
    expect(pending.length).toBeGreaterThanOrEqual(15);
    expect(tasks.every((t) => t.status !== "failed")).toBe(true);

    deferreds.forEach((d) => d.resolve(makeAgentResult()));
    manager.dispose();
  });

  it("auto-launches pending task when a running task completes", async () => {
    const deferred = createDeferred<AgentResult>();
    let callCount = 0;
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => {
            if (callCount++ === 0) return deferred.promise;
            return makeAgentResult();
          },
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create({
      maxConcurrentTotal: 1,
      maxConcurrentPerAgent: 10,
      maxDescendants: 10,
    });

    await manager.launch({
      agentName: "worker",
      prompt: "first",
      model,
      parentSessionId,
    });
    const second = await manager.launch({
      agentName: "worker",
      prompt: "second",
      model,
      parentSessionId,
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(manager.getTask(second.id)?.status).toBe("pending");

    deferred.resolve(makeAgentResult());
    await new Promise((r) => setTimeout(r, 100));

    const secondStatus = manager.getTask(second.id)?.status;
    expect(secondStatus === "running" || secondStatus === "completed").toBe(true);

    manager.dispose();
  });

  it("fails with queue-full error when queue capacity is exceeded", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create({
      maxConcurrentTotal: 1,
      maxQueueSize: 3,
      maxConcurrentPerAgent: 10,
      maxDescendants: 10,
    });

    await manager.launch({ agentName: "worker", prompt: "running", model, parentSessionId });
    await new Promise((r) => setTimeout(r, 10));

    await manager.launch({ agentName: "worker", prompt: "q1", model, parentSessionId });
    await manager.launch({ agentName: "worker", prompt: "q2", model, parentSessionId });
    await manager.launch({ agentName: "worker", prompt: "q3", model, parentSessionId });
    const overflow = await manager.launch({
      agentName: "worker",
      prompt: "overflow",
      model,
      parentSessionId,
    });

    expect(overflow.status).toBe("failed");
    expect(overflow.error).toContain("queue full");

    deferred.resolve(makeAgentResult());
    manager.dispose();
  });

  it("stats() returns correct active, pending, and total counts", async () => {
    const deferreds = Array.from({ length: 5 }, () => createDeferred<AgentResult>());
    let callCount = 0;
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferreds[callCount++].promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create({
      maxConcurrentTotal: 2,
      maxConcurrentPerAgent: 10,
      maxDescendants: 10,
    });

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        manager.launch({ agentName: "worker", prompt: `task ${i}`, model, parentSessionId }),
      ),
    );

    await new Promise((r) => setTimeout(r, 20));

    const s = manager.stats();
    expect(s.active).toBe(2);
    expect(s.pending).toBe(3);
    expect(s.total).toBe(5);

    deferreds.forEach((d) => d.resolve(makeAgentResult()));
    manager.dispose();
  });

  it("dispose() stops the cleanup interval without throwing", () => {
    spawnSpy = spyOn(SubagentRuntime, "spawnBackground").mockResolvedValue({
      sessionId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });

    const manager = BackgroundManager.create();
    expect(() => manager.dispose()).not.toThrow();
  });

  it("cancelled pending task is not launched when slot opens", async () => {
    const deferred = createDeferred<AgentResult>();
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: async (_input: ChatAgentInput) => deferred.promise,
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const parentSessionId = crypto.randomUUID();
    const manager = BackgroundManager.create({
      maxConcurrentTotal: 1,
      maxConcurrentPerAgent: 10,
      maxDescendants: 10,
    });

    await manager.launch({ agentName: "worker", prompt: "first", model, parentSessionId });
    const queued = await manager.launch({
      agentName: "worker",
      prompt: "queued",
      model,
      parentSessionId,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(manager.getTask(queued.id)?.status).toBe("pending");

    await manager.cancel(queued.id);
    expect(manager.getTask(queued.id)?.status).toBe("cancelled");

    deferred.resolve(makeAgentResult());
    await new Promise((r) => setTimeout(r, 50));

    expect(manager.stats().pending).toBe(0);
    manager.dispose();
  });
});
