import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  ChatAgent,
  type AgentResult,
  type ChatAgentConfig,
  type ChatAgentInput,
} from "@openomni/agent";
import { Session, Storage, WorkerRun } from "@openomni/session";
import {
  AbortControllerRegistry,
  MAX_ENTRY_AGE_MS,
  abort,
  get,
  register,
  remove,
  startSweep,
  stopSweep,
  sweep,
} from "../../src/subagent/abort-registry";
import { SubagentRuntime } from "../../src/subagent/runtime";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

let createSpy: ReturnType<typeof spyOn>;

function createResult(text: string): AgentResult {
  return {
    text,
    steps: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    finishReason: "stop",
  };
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  createSpy = spyOn(ChatAgent, "create");
});

afterEach(() => {
  createSpy.mockRestore();
  Storage.reset();
  stopSweep();
  AbortControllerRegistry.clear();
});

describe("AbortControllerRegistry — nested map structure", () => {
  it("registers run-level entries under session map", () => {
    const sessionId = crypto.randomUUID();

    register(sessionId, "run-1");
    register(sessionId, "run-2");

    expect(get(sessionId, "run-1")).toBeDefined();
    expect(get(sessionId, "run-2")).toBeDefined();
    expect(AbortControllerRegistry.get(sessionId)?.size).toBe(2);
  });

  it("reuses existing entry when controller is not aborted", () => {
    const sessionId = crypto.randomUUID();
    const first = register(sessionId, "run-1");
    const second = register(sessionId, "run-1");

    expect(second).toBe(first);
  });

  it("creates fresh entry when existing controller is aborted", () => {
    const sessionId = crypto.randomUUID();
    const first = register(sessionId, "run-1");
    first.controller.abort();
    const second = register(sessionId, "run-1");

    expect(second).not.toBe(first);
    expect(second.controller.signal.aborted).toBe(false);
  });

  it("multi-run independent abort: aborting run-A does not affect run-B", () => {
    const sessionId = crypto.randomUUID();
    const entryA = register(sessionId, "run-A");
    const entryB = register(sessionId, "run-B");

    abort(sessionId, "run-A");

    expect(entryA.controller.signal.aborted).toBe(true);
    expect(get(sessionId, "run-A")).toBeUndefined();
    expect(entryB.controller.signal.aborted).toBe(false);
    expect(get(sessionId, "run-B")).toBeDefined();
  });

  it("session-wide abort: aborts all runs and removes session map", () => {
    const sessionId = crypto.randomUUID();
    const entryA = register(sessionId, "run-A");
    const entryB = register(sessionId, "run-B");

    abort(sessionId);

    expect(entryA.controller.signal.aborted).toBe(true);
    expect(entryB.controller.signal.aborted).toBe(true);
    expect(AbortControllerRegistry.has(sessionId)).toBe(false);
  });

  it("auto-cleanup: removes session map when last run entry is removed", () => {
    const sessionId = crypto.randomUUID();
    register(sessionId, "run-1");
    register(sessionId, "run-2");

    remove(sessionId, "run-1");
    expect(AbortControllerRegistry.has(sessionId)).toBe(true);

    remove(sessionId, "run-2");
    expect(AbortControllerRegistry.has(sessionId)).toBe(false);
  });

  it("remove is a no-op for non-existent session or run", () => {
    expect(() => remove("ghost-session", "ghost-run")).not.toThrow();

    const sessionId = crypto.randomUUID();
    register(sessionId, "run-1");
    expect(() => remove(sessionId, "ghost-run")).not.toThrow();
    expect(get(sessionId, "run-1")).toBeDefined();
  });

  it("abort is a no-op for non-existent session", () => {
    expect(() => abort("ghost-session")).not.toThrow();
    expect(() => abort("ghost-session", "ghost-run")).not.toThrow();
  });
});

describe("AbortControllerRegistry — orphan sweep", () => {
  it("removes aborted entries", () => {
    const sessionId = crypto.randomUUID();
    const entry = register(sessionId, "run-1");
    register(sessionId, "run-2");
    entry.controller.abort();

    const removed = sweep();

    expect(removed).toBe(1);
    expect(get(sessionId, "run-1")).toBeUndefined();
    expect(get(sessionId, "run-2")).toBeDefined();
  });

  it("removes entries older than maxAgeMs", () => {
    const sessionId = crypto.randomUUID();
    register(sessionId, "old-run");

    // backdate the entry
    const sessionMap = AbortControllerRegistry.get(sessionId)!;
    const oldEntry = sessionMap.get("old-run")!;
    (oldEntry as { createdAt: number }).createdAt = Date.now() - MAX_ENTRY_AGE_MS - 1;

    register(sessionId, "fresh-run");

    const removed = sweep();

    expect(removed).toBe(1);
    expect(get(sessionId, "old-run")).toBeUndefined();
    expect(get(sessionId, "fresh-run")).toBeDefined();
  });

  it("cleans up empty session maps after sweep", () => {
    const sessionId = crypto.randomUUID();
    const entry = register(sessionId, "run-1");
    entry.controller.abort();

    sweep();

    expect(AbortControllerRegistry.has(sessionId)).toBe(false);
  });

  it("returns zero when nothing to sweep", () => {
    expect(sweep()).toBe(0);

    const sessionId = crypto.randomUUID();
    register(sessionId, "active-run");
    expect(sweep()).toBe(0);
  });

  it("accepts custom maxAgeMs", () => {
    const sessionId = crypto.randomUUID();
    register(sessionId, "run-1");

    // backdate by 5 seconds
    const sessionMap = AbortControllerRegistry.get(sessionId)!;
    const entry = sessionMap.get("run-1")!;
    (entry as { createdAt: number }).createdAt = Date.now() - 5_000;

    expect(sweep(10_000)).toBe(0);
    expect(sweep(3_000)).toBe(1);
  });

  it("startSweep does not create multiple intervals", () => {
    startSweep(60_000);
    startSweep(60_000);
    startSweep(60_000);

    // no throw, idempotent — cleanup in afterEach
  });

  it("stopSweep is idempotent", () => {
    stopSweep();
    startSweep(60_000);
    stopSweep();
    stopSweep();
    // no throw
  });

  it("periodic sweep removes stale entries via timer", async () => {
    const sessionId = crypto.randomUUID();
    const entry = register(sessionId, "run-1");
    entry.controller.abort();

    startSweep(50);

    await new Promise((r) => setTimeout(r, 120));

    expect(get(sessionId, "run-1")).toBeUndefined();
    expect(AbortControllerRegistry.has(sessionId)).toBe(false);
  });
});

describe("SubagentRuntime abort propagation — regression", () => {
  it("combines external signal during spawn and cleans registry on completion", async () => {
    const external = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    createSpy.mockImplementation((config: ChatAgentConfig) => {
      capturedSignal = config.signal;
      return {
        run: async (_input: ChatAgentInput) => createResult("done"),
      } as ReturnType<typeof ChatAgent.create>;
    });

    const result = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task",
      prompt: "do work",
      model,
      signal: external.signal,
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).not.toBe(external.signal);
    external.abort();
    expect(capturedSignal?.aborted).toBe(true);
    expect(AbortControllerRegistry.has(result.sessionId)).toBe(false);
  });

  it("combines external signal during send and cleans registry on completion", async () => {
    let createCount = 0;
    let capturedSignal: AbortSignal | undefined;

    createSpy.mockImplementation((config: ChatAgentConfig) => {
      createCount += 1;
      if (createCount === 2) {
        capturedSignal = config.signal;
      }

      return {
        run: async (_input: ChatAgentInput) => createResult(createCount === 1 ? "first" : "second"),
      } as ReturnType<typeof ChatAgent.create>;
    });

    const spawned = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "task",
      prompt: "first",
      model,
    });

    const external = new AbortController();
    await SubagentRuntime.send({
      sessionId: spawned.sessionId,
      prompt: "second",
      model,
      signal: external.signal,
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).not.toBe(external.signal);
    external.abort();
    expect(capturedSignal?.aborted).toBe(true);
    expect(AbortControllerRegistry.has(spawned.sessionId)).toBe(false);
  });

  it("aborts the active controller when cancelling a running spawn", async () => {
    let capturedSignal: AbortSignal | undefined;

    createSpy.mockImplementation((config: ChatAgentConfig) => {
      capturedSignal = config.signal;
      return {
        run: async (_input: ChatAgentInput) => {
          if (!config.signal) {
            throw new Error("signal missing");
          }

          return new Promise<AgentResult>((_resolve, reject) => {
            config.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      } as ReturnType<typeof ChatAgent.create>;
    });

    const pendingSpawn = SubagentRuntime.spawn({
      agentName: "worker",
      title: "task",
      prompt: "do work",
      model,
    });

    const sessionId = await waitForSessionId();
    const runId = await waitForRunningRun(sessionId);
    const entry = get(sessionId, runId);
    expect(entry).toBeDefined();
    expect(entry?.controller.signal.aborted).toBe(false);

    await SubagentRuntime.cancel({ sessionId });

    expect(capturedSignal?.aborted).toBe(true);
    await expectSpawnAbort(pendingSpawn);
    expect(AbortControllerRegistry.has(sessionId)).toBe(false);
  });
});

async function waitForSessionId(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sessionId = Session.list()[0]?.id;
    if (sessionId) {
      return sessionId;
    }

    await Promise.resolve();
  }

  throw new Error("session was not created");
}

async function waitForRunningRun(sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const runs = await WorkerRun.listBySession(sessionId);
    const running = runs.find((run) => run.status === "running");
    if (running) return running.runId;

    await new Promise((r) => setTimeout(r, 10));
  }

  throw new Error("worker run did not reach running state");
}

async function expectSpawnAbort(pendingSpawn: Promise<unknown>): Promise<void> {
  try {
    await pendingSpawn;
    throw new Error("spawn should have rejected");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("aborted");
  }
}
