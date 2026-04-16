import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatAgent, type AgentResult, type ChatAgentConfig } from "@openomni/agent";
import { Subagent } from "@openomni/protocol";
import { Bus, Session, Storage, WorkerRun } from "@openomni/session";
import { AbortControllerRegistry, get as getAbortEntry } from "../../src/subagent/abort-registry";
import { SubagentRuntime } from "../../src/subagent/runtime";

const model = { provider: "anthropic", id: "claude-3-haiku-20240307" };

let createSpy: ReturnType<typeof spyOn>;

// biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for suppressing orphaned spawn rejections
const noop = () => {};

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
  Bus.reset();
});

afterEach(() => {
  createSpy?.mockRestore();
  Storage.reset();
  Bus.reset();
});

describe("cancel timeout race", () => {
  it("forces status to interrupted when agent ignores abort signal", async () => {
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: () => new Promise<AgentResult>(noop),
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const spawnPromise = SubagentRuntime.spawn({
      agentName: "worker",
      title: "hanging",
      prompt: "work",
      model,
    });
    spawnPromise.catch(noop);

    const sessionId = await waitForSessionId();
    const runId = await waitForRunningRun(sessionId);

    const failEvents: Array<{ error?: string }> = [];
    Bus.subscribe(Subagent.Events.WorkerRunFailed, (event: unknown) => {
      failEvents.push((event as { payload: { error?: string } }).payload);
    });

    await SubagentRuntime.cancel({ sessionId, hardTimeoutMs: 100 });

    const run = await WorkerRun.get(sessionId, runId);
    expect(run?.status).toBe("interrupted");
    expect(failEvents).toHaveLength(1);
    expect(failEvents[0].error).toBe("cancel timeout exceeded");
    expect(getAbortEntry(sessionId, runId)).toBeUndefined();
  });

  it("resolves with cancelled when abort completes before timeout", async () => {
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      (config: ChatAgentConfig) =>
        ({
          run: () =>
            new Promise<AgentResult>((_resolve, reject) => {
              config.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }),
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const spawnPromise = SubagentRuntime.spawn({
      agentName: "worker",
      title: "abortable",
      prompt: "work",
      model,
    });
    spawnPromise.catch(noop);

    const sessionId = await waitForSessionId();
    const runId = await waitForRunningRun(sessionId);

    const failEvents: Array<{ error?: string }> = [];
    Bus.subscribe(Subagent.Events.WorkerRunFailed, (event: unknown) => {
      failEvents.push((event as { payload: { error?: string } }).payload);
    });

    await SubagentRuntime.cancel({ sessionId, hardTimeoutMs: 2000 });

    const run = await WorkerRun.get(sessionId, runId);
    expect(run?.status).toBe("cancelled");
    expect(failEvents).toHaveLength(0);
  });

  it("accepts cancel without hardTimeoutMs and uses default", async () => {
    const session = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    });

    const runId = crypto.randomUUID();
    await WorkerRun.create(session.id, { runId, title: "t", prompt: "t" });
    await WorkerRun.updateStatus(session.id, runId, "starting");
    await WorkerRun.updateStatus(session.id, runId, "running");

    await SubagentRuntime.cancel({ sessionId: session.id, runId });

    const run = await WorkerRun.get(session.id, runId);
    expect(run?.status).toBe("cancelled");
  });

  it("forces interrupted on specific runId when timeout exceeded", async () => {
    createSpy = spyOn(ChatAgent, "create").mockImplementation(
      () =>
        ({
          run: () => new Promise<AgentResult>(noop),
        }) as ReturnType<typeof ChatAgent.create>,
    );

    const spawnPromise = SubagentRuntime.spawn({
      agentName: "worker",
      title: "hanging",
      prompt: "work",
      model,
    });
    spawnPromise.catch(noop);

    const sessionId = await waitForSessionId();
    const runId = await waitForRunningRun(sessionId);

    await SubagentRuntime.cancel({ sessionId, runId, hardTimeoutMs: 100 });

    const run = await WorkerRun.get(sessionId, runId);
    expect(run?.status).toBe("interrupted");
  });

  it("preserves direct cancel when no in-flight operation exists", async () => {
    const session = Session.create({
      title: "test",
      model: { providerID: "anthropic", modelID: "claude-3-haiku-20240307" },
    });

    const runId = crypto.randomUUID();
    await WorkerRun.create(session.id, { runId, title: "t", prompt: "t" });
    await WorkerRun.updateStatus(session.id, runId, "starting");
    await WorkerRun.updateStatus(session.id, runId, "running");

    await SubagentRuntime.cancel({ sessionId: session.id });

    const run = await WorkerRun.get(session.id, runId);
    expect(run?.status).toBe("cancelled");
  });
});
