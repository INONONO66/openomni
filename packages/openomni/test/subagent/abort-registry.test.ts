import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  ChatAgent,
  type AgentResult,
  type ChatAgentConfig,
  type ChatAgentInput,
} from "@openomni/agent";
import { Session, Storage, WorkerRun } from "@openomni/session";
import { abort, get, register, remove } from "../../src/subagent/abort-registry";
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
  createSpy = spyOn(ChatAgent, "create");
});

afterEach(() => {
  createSpy.mockRestore();
  Storage.reset();
});

describe("AbortControllerRegistry", () => {
  it("registers controllers, aborts them, and removes entries", () => {
    const sessionId = crypto.randomUUID();
    const entry = register(sessionId, "run-1");

    expect(get(sessionId)?.activeRunId).toBe("run-1");
    expect(entry.controller.signal.aborted).toBe(false);

    abort(sessionId);
    expect(entry.controller.signal.aborted).toBe(true);
    expect(get(sessionId)).toBeUndefined();

    register(sessionId, "run-2");
    remove(sessionId);
    expect(get(sessionId)).toBeUndefined();
  });
});

describe("SubagentRuntime abort propagation", () => {
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
    expect(get(result.sessionId)).toBeUndefined();
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
    expect(get(spawned.sessionId)).toBeUndefined();
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
    const entry = await waitForAbortEntry(sessionId);
    await waitForRunningRun(sessionId);
    expect(entry.controller.signal.aborted).toBe(false);

    await SubagentRuntime.cancel({ sessionId });

    expect(capturedSignal?.aborted).toBe(true);
    await expectSpawnAbort(pendingSpawn);
    expect(get(sessionId)).toBeUndefined();
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

async function waitForAbortEntry(sessionId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const entry = get(sessionId);
    if (entry) {
      return entry;
    }

    await Promise.resolve();
  }

  throw new Error("abort registry entry was not created");
}

async function waitForRunningRun(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runs = await WorkerRun.listBySession(sessionId);
    if (runs.some((run) => run.status === "running")) {
      return;
    }

    await Promise.resolve();
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
