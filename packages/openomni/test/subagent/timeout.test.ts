import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentConfig } from "@openomni/agent";
import { Subagent } from "@openomni/protocol";
import { Bus, Session, Storage, WorkerRun } from "@openomni/session";
import { SubagentRuntime } from "../../src/subagent/runtime";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

let createSpy: ReturnType<typeof spyOn>;

// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for suppressing orphaned spawn rejections
const noop = () => {};

function mockSlowAgent(durationMs: number) {
  return spyOn(ChatAgent, "create").mockImplementation(
    (config: ChatAgentConfig) =>
      ({
        run: () =>
          new Promise<AgentResult>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                resolve({
                  text: "done",
                  steps: [],
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                  finishReason: "stop",
                }),
              durationMs,
            );
            config.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
      }) as unknown as ReturnType<typeof ChatAgent.create>,
  );
}

async function waitForSessionId(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const sessions = Session.list();
    if (sessions.length > 0) return sessions[0].id;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("session was not created");
}

async function waitForRunningRun(sessionId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const runs = await WorkerRun.listBySession(sessionId);
    const running = runs.find((r) => r.status === "running");
    if (running) return running.runId;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("worker run did not reach running state");
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Bus.reset();
});

afterEach(() => {
  createSpy?.mockRestore();
  Storage.reset();
  Bus.reset();
});

describe("soft/hard timeout for worker runs", () => {
  it("does not emit lifecycle failure for soft timeout without a status change", async () => {
    createSpy = mockSlowAgent(200);

    const failEvents: Array<{ error?: string }> = [];
    Bus.subscribe(Subagent.Events.WorkerRunFailed, (event: unknown) => {
      failEvents.push((event as { payload: { error?: string } }).payload);
    });

    const result = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "soft-timeout-test",
      prompt: "work",
      model,
      softTimeoutMs: 50,
    });

    expect(result.output).toBe("done");
    const softWarnings = failEvents.filter((e) => e.error === "soft timeout exceeded");
    expect(softWarnings).toHaveLength(0);
  });

  it("aborts and transitions to interrupted on hard timeout", async () => {
    createSpy = mockSlowAgent(500);

    const failEvents: Array<{ error?: string }> = [];
    Bus.subscribe(Subagent.Events.WorkerRunFailed, (event: unknown) => {
      failEvents.push((event as { payload: { error?: string } }).payload);
    });

    const spawnPromise = SubagentRuntime.spawn({
      agentName: "worker",
      title: "hard-timeout-test",
      prompt: "work",
      model,
      hardTimeoutMs: 50,
    });
    spawnPromise.catch(noop);

    const sessionId = await waitForSessionId();
    const runId = await waitForRunningRun(sessionId);

    await new Promise((r) => setTimeout(r, 200));

    const run = await WorkerRun.get(sessionId, runId);
    expect(run?.status).toBe("interrupted");
    const hardEvents = failEvents.filter((e) => e.error === "hard timeout exceeded");
    expect(hardEvents).toHaveLength(1);
  });

  it("emits only the hard timeout lifecycle failure when hard timeout aborts", async () => {
    createSpy = mockSlowAgent(500);

    const eventLog: string[] = [];
    Bus.subscribe(Subagent.Events.WorkerRunFailed, (event: unknown) => {
      const payload = (event as { payload: { error?: string } }).payload;
      if (payload.error) eventLog.push(payload.error);
    });

    const spawnPromise = SubagentRuntime.spawn({
      agentName: "worker",
      title: "both-timeouts",
      prompt: "work",
      model,
      softTimeoutMs: 50,
      hardTimeoutMs: 150,
    });
    spawnPromise.catch(noop);

    const sessionId = await waitForSessionId();
    const runId = await waitForRunningRun(sessionId);

    await new Promise((r) => setTimeout(r, 300));

    const run = await WorkerRun.get(sessionId, runId);
    expect(run?.status).toBe("interrupted");
    expect(eventLog).toContain("hard timeout exceeded");
    expect(eventLog).not.toContain("soft timeout exceeded");
  });

  it("clears timers when run completes before timeout", async () => {
    createSpy = mockSlowAgent(30);

    const failEvents: Array<{ error?: string }> = [];
    Bus.subscribe(Subagent.Events.WorkerRunFailed, (event: unknown) => {
      failEvents.push((event as { payload: { error?: string } }).payload);
    });

    const result = await SubagentRuntime.spawn({
      agentName: "worker",
      title: "fast-run",
      prompt: "work",
      model,
      softTimeoutMs: 200,
      hardTimeoutMs: 400,
    });

    expect(result.output).toBe("done");

    await new Promise((r) => setTimeout(r, 500));

    const timeoutEvents = failEvents.filter(
      (e) => e.error === "soft timeout exceeded" || e.error === "hard timeout exceeded",
    );
    expect(timeoutEvents).toHaveLength(0);
  });

  it("send respects hardTimeoutMs", async () => {
    createSpy = mockSlowAgent(500);

    const session = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    });
    const workerMeta = Subagent.ChildSessionMeta.parse({
      kind: "subagent",
      agentName: "worker",
      spawnDepth: 0,
      status: "idle",
    });
    Session.updateWorkerMeta(session.id, workerMeta);

    const failEvents: Array<{ error?: string }> = [];
    Bus.subscribe(Subagent.Events.WorkerRunFailed, (event: unknown) => {
      failEvents.push((event as { payload: { error?: string } }).payload);
    });

    const sendPromise = SubagentRuntime.send({
      sessionId: session.id,
      prompt: "work",
      model,
      hardTimeoutMs: 50,
    });
    sendPromise.catch(noop);

    await new Promise((r) => setTimeout(r, 200));

    const runs = await WorkerRun.listBySession(session.id);
    expect(runs.length).toBeGreaterThan(0);
    const run = runs[runs.length - 1];
    expect(run?.status).toBe("interrupted");
    expect(failEvents.some((e) => e.error === "hard timeout exceeded")).toBe(true);
  });

  it("send respects softTimeoutMs without aborting", async () => {
    createSpy = mockSlowAgent(200);

    const session = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    });
    const workerMeta = Subagent.ChildSessionMeta.parse({
      kind: "subagent",
      agentName: "worker",
      spawnDepth: 0,
      status: "idle",
    });
    Session.updateWorkerMeta(session.id, workerMeta);

    const failEvents: Array<{ error?: string }> = [];
    Bus.subscribe(Subagent.Events.WorkerRunFailed, (event: unknown) => {
      failEvents.push((event as { payload: { error?: string } }).payload);
    });

    const result = await SubagentRuntime.send({
      sessionId: session.id,
      prompt: "work",
      model,
      softTimeoutMs: 50,
    });

    expect(result.output).toBe("done");
    expect(failEvents.some((e) => e.error === "soft timeout exceeded")).toBe(false);
  });
});
