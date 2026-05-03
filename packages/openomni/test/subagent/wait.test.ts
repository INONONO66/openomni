import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Bus, Session, Storage, WorkerRun } from "@openomni/session";
import type { Message } from "@openomni/protocol";
import { SubagentRuntime } from "../../src/subagent/runtime";

async function makeRunningSession(): Promise<{ sessionId: string; runId: string }> {
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();

  Storage.getAdapter().session.set(sessionId, {
    id: sessionId,
    title: "Test",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now(), updated: Date.now() },
    spawnDepth: 0,
  });

  await WorkerRun.create(sessionId, { runId, title: "Test Run", prompt: "test" });
  await WorkerRun.updateStatus(sessionId, runId, "starting");
  await WorkerRun.updateStatus(sessionId, runId, "running");

  return { sessionId, runId };
}

async function makeCompletedMessage(sessionId: string, text: string) {
  const msg: Message.AssistantMessage = {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "test",
    providerID: "test",
    agent: "test",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  Session.addMessage(sessionId, msg);
  Session.addPart(msg.id, {
    id: crypto.randomUUID(),
    sessionID: sessionId,
    messageID: msg.id,
    type: "text",
    text,
  } satisfies Message.TextPart);
  return msg;
}

describe("wait() — event-driven (no polling)", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
    Bus.reset();
  });

  afterEach(() => {
    Storage.reset();
    Bus.reset();
  });

  test("resolves when WorkerRunCompleted fires", async () => {
    const { sessionId, runId } = await makeRunningSession();
    const msg = await makeCompletedMessage(sessionId, "done");

    const waitPromise = SubagentRuntime.wait({ sessionId, runId });

    setTimeout(async () => {
      await WorkerRun.updateStatus(sessionId, runId, "succeeded", {
        endedAt: Date.now(),
        lastMessageId: msg.id,
      });
    }, 20);

    const result = await waitPromise;
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("done");
  });

  test("resolves when WorkerRunFailed fires", async () => {
    const { sessionId, runId } = await makeRunningSession();

    const waitPromise = SubagentRuntime.wait({ sessionId, runId });

    setTimeout(async () => {
      await WorkerRun.updateStatus(sessionId, runId, "failed", {
        endedAt: Date.now(),
        error: "something went wrong",
      });
    }, 20);

    const result = await waitPromise;
    expect(result.status).toBe("failed");
  });

  test("rejects on timeout", async () => {
    const { sessionId, runId } = await makeRunningSession();

    const err = await SubagentRuntime.wait({ sessionId, runId, timeoutMs: 80 }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("timeout");
  });

  test("race condition: resolves immediately when run is already terminal before subscribe", async () => {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    Storage.getAdapter().session.set(sessionId, {
      id: sessionId,
      title: "Test",
      model: { providerID: "test", modelID: "test" },
      time: { created: Date.now(), updated: Date.now() },
      spawnDepth: 0,
    });

    await WorkerRun.create(sessionId, { runId, title: "Run", prompt: "test" });
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");
    await WorkerRun.updateStatus(sessionId, runId, "succeeded", { endedAt: Date.now() });

    // no Bus event ever fires — relies on terminal-status check at the top of wait()
    const result = await SubagentRuntime.wait({ sessionId, runId });
    expect(result.status).toBe("succeeded");
  });

  test("100 concurrent waiters — no timer explosion", async () => {
    const pairs = await Promise.all(Array.from({ length: 100 }, () => makeRunningSession()));

    const waiters = pairs.map(({ sessionId, runId }) =>
      SubagentRuntime.wait({ sessionId, runId, timeoutMs: 5000 }),
    );

    await Promise.all(
      pairs.map(async ({ sessionId, runId }) => {
        await WorkerRun.updateStatus(sessionId, runId, "succeeded", { endedAt: Date.now() });
      }),
    );

    const results = await Promise.all(waiters);
    expect(results).toHaveLength(100);
    expect(results.every((r) => r.status === "succeeded")).toBe(true);
  });
});
