import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentInput } from "@openomni/agent";
import { Subagent } from "@openomni/protocol";
import { Bus, Session, Storage, WorkerRun } from "@openomni/session";
import { SubagentRuntime } from "../../src/subagent/runtime";

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
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    finishReason: "stop",
  };
}

describe("SubagentRuntime.spawnBackground()", () => {
  const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

  let createSpy: ReturnType<typeof spyOn>;
  let runCalls: ChatAgentInput[];

  beforeEach(() => {
    Storage.reset();
    Bus.reset();
    runCalls = [];
  });

  afterEach(() => {
    createSpy?.mockRestore();
    Bus.reset();
  });

  it("returns sessionId and runId before the background run completes", async () => {
    const deferred = createDeferred<AgentResult>();
    const completedEvents: Array<{ sessionId?: string; runId?: string; status?: string }> = [];

    createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
      return {
        run: async (input: ChatAgentInput) => {
          runCalls.push(input);
          return deferred.promise;
        },
      } as unknown as ReturnType<typeof ChatAgent.create>;
    });

    const unsubscribe = Bus.subscribe(Subagent.Events.WorkerRunCompleted, (event) => {
      completedEvents.push(event as { sessionId?: string; runId?: string; status?: string });
    });

    const started = await SubagentRuntime.spawnBackground({
      agentName: "worker",
      title: "background task",
      prompt: "solve this in background",
      model,
    });

    expect(started.sessionId).toBeString();
    expect(started.runId).toBeString();
    expect("output" in started).toBe(false);
    expect("finishReason" in started).toBe(false);

    const session = Session.get(started.sessionId);
    expect(session).toBeDefined();

    const activeRun = await WorkerRun.get(started.sessionId, started.runId);
    expect(activeRun?.status).toBe("running");
    expect(activeRun?.lastMessageId).toBeUndefined();

    await Promise.resolve();
    expect(runCalls).toHaveLength(1);

    deferred.resolve(createAgentResult("background output"));

    const waited = await SubagentRuntime.wait({
      sessionId: started.sessionId,
      runId: started.runId,
      timeoutMs: 1_000,
    });

    expect(waited).toEqual({ status: "succeeded", output: "background output" });

    const finalRun = await WorkerRun.get(started.sessionId, started.runId);
    expect(finalRun?.status).toBe("succeeded");
    expect(finalRun?.endedAt).toBeDefined();
    expect(finalRun?.lastMessageId).toBeString();
    expect(completedEvents.some((event) => event.runId === started.runId)).toBe(true);

    unsubscribe();
  });

  it("marks the background run as failed and publishes a failure event", async () => {
    const deferred = createDeferred<AgentResult>();
    const failedEvents: Array<{ sessionId?: string; runId?: string; error?: string }> = [];

    createSpy = spyOn(ChatAgent, "create").mockImplementation(() => {
      return {
        run: async () => deferred.promise,
      } as unknown as ReturnType<typeof ChatAgent.create>;
    });

    const unsubscribe = Bus.subscribe(Subagent.Events.WorkerRunFailed, (event) => {
      failedEvents.push(event as { sessionId?: string; runId?: string; error?: string });
    });

    const started = await SubagentRuntime.spawnBackground({
      agentName: "worker",
      title: "background task",
      prompt: "fail this run",
      model,
    });

    deferred.reject(new Error("background boom"));

    const waited = await SubagentRuntime.wait({
      sessionId: started.sessionId,
      runId: started.runId,
      timeoutMs: 1_000,
    });

    expect(waited).toEqual({ status: "failed", output: undefined });

    const failedRun = await WorkerRun.get(started.sessionId, started.runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.endedAt).toBeDefined();
    expect(failedEvents.some((event) => event.runId === started.runId)).toBe(true);

    unsubscribe();
  });
});
