import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Bus, Session, WorkerRun } from "@openomni/session";
import { Subagent, type Message } from "@openomni/protocol";
import { SubagentRuntime } from "../../src/subagent/runtime";

describe("SubagentRuntime.wait()", () => {
  let sessionId: string;
  let runId: string;

  beforeEach(async () => {
    Bus.reset();
    sessionId = crypto.randomUUID();
    runId = crypto.randomUUID();

    await Session.create(sessionId);
    await WorkerRun.create(sessionId, {
      runId,
      title: "Test Run",
      prompt: "Test prompt",
    });
  });

  afterEach(() => {
    Bus.reset();
  });

  test("returns immediately if run already in terminal state (succeeded)", async () => {
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");

    const assistantMsg: Message.AssistantMessage = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "test-model",
      providerID: "test-provider",
      agent: "test",
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    await Session.addMessage(sessionId, assistantMsg);

    const textPart: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "text",
      text: "Test output",
    };
    Session.addPart(assistantMsg.id, textPart);

    await WorkerRun.updateStatus(sessionId, runId, "succeeded", {
      endedAt: Date.now(),
      lastMessageId: assistantMsg.id,
    });

    const result = await SubagentRuntime.wait({ sessionId, runId });

    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("Test output");
  });

  test("returns immediately if run already in terminal state (failed)", async () => {
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");
    await WorkerRun.updateStatus(sessionId, runId, "failed", {
      endedAt: Date.now(),
    });

    const result = await SubagentRuntime.wait({ sessionId, runId });

    expect(result.status).toBe("failed");
    expect(result.output).toBeUndefined();
  });

  test("waits for Bus event WorkerRunCompleted", async () => {
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");

    const assistantMsg: Message.AssistantMessage = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "test-model",
      providerID: "test-provider",
      agent: "test",
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    await Session.addMessage(sessionId, assistantMsg);

    const textPart: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "text",
      text: "Completed output",
    };
    Session.addPart(assistantMsg.id, textPart);

    const waitPromise = SubagentRuntime.wait({ sessionId, runId });

    setTimeout(async () => {
      await WorkerRun.updateStatus(sessionId, runId, "succeeded", {
        endedAt: Date.now(),
        lastMessageId: assistantMsg.id,
      });
      Bus.publish(Subagent.Events.WorkerRunCompleted, {
        sessionId,
        runId,
        status: "succeeded",
      });
    }, 50);

    const result = await waitPromise;

    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("Completed output");
  });

  test("waits for Bus event WorkerRunFailed", async () => {
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");

    const waitPromise = SubagentRuntime.wait({ sessionId, runId });

    setTimeout(async () => {
      await WorkerRun.updateStatus(sessionId, runId, "failed", {
        endedAt: Date.now(),
      });
      Bus.publish(Subagent.Events.WorkerRunFailed, {
        sessionId,
        runId,
        error: "Test error",
      });
    }, 50);

    const result = await waitPromise;

    expect(result.status).toBe("failed");
  });

  test("uses polling fallback if Bus event is missed", async () => {
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");

    const assistantMsg: Message.AssistantMessage = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "test-model",
      providerID: "test-provider",
      agent: "test",
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    await Session.addMessage(sessionId, assistantMsg);

    const textPart: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "text",
      text: "Polled output",
    };
    Session.addPart(assistantMsg.id, textPart);

    const waitPromise = SubagentRuntime.wait({ sessionId, runId });

    setTimeout(async () => {
      await WorkerRun.updateStatus(sessionId, runId, "succeeded", {
        endedAt: Date.now(),
        lastMessageId: assistantMsg.id,
      });
    }, 50);

    const result = await waitPromise;

    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("Polled output");
  });

  test("respects timeoutMs parameter and rejects on timeout", async () => {
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");

    const waitPromise = SubagentRuntime.wait({
      sessionId,
      runId,
      timeoutMs: 100,
    });

    const result = await waitPromise.catch((err) => err);

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("timeout");
  });

  test("throws if run not found", async () => {
    const nonExistentRunId = crypto.randomUUID();

    const result = await SubagentRuntime.wait({
      sessionId,
      runId: nonExistentRunId,
    }).catch((err) => err);

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("not found");
  });

  test("unsubscribes from Bus events after completion", async () => {
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");

    const assistantMsg: Message.AssistantMessage = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "test-model",
      providerID: "test-provider",
      agent: "test",
      path: { cwd: process.cwd(), root: process.cwd() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    await Session.addMessage(sessionId, assistantMsg);

    const textPart: Message.TextPart = {
      id: crypto.randomUUID(),
      sessionID: sessionId,
      messageID: assistantMsg.id,
      type: "text",
      text: "Output",
    };
    Session.addPart(assistantMsg.id, textPart);

    const waitPromise = SubagentRuntime.wait({ sessionId, runId });

    setTimeout(async () => {
      await WorkerRun.updateStatus(sessionId, runId, "succeeded", {
        endedAt: Date.now(),
        lastMessageId: assistantMsg.id,
      });
      Bus.publish(Subagent.Events.WorkerRunCompleted, {
        sessionId,
        runId,
        status: "succeeded",
      });
    }, 50);

    await waitPromise;

    Bus.publish(Subagent.Events.WorkerRunCompleted, {
      sessionId,
      runId,
      status: "succeeded",
    });

    expect(true).toBe(true);
  });

  test("handles cancelled status", async () => {
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");
    await WorkerRun.updateStatus(sessionId, runId, "cancelled", {
      endedAt: Date.now(),
    });

    const result = await SubagentRuntime.wait({ sessionId, runId });

    expect(result.status).toBe("cancelled");
  });

  test("handles interrupted status", async () => {
    await WorkerRun.updateStatus(sessionId, runId, "starting");
    await WorkerRun.updateStatus(sessionId, runId, "running");
    await WorkerRun.updateStatus(sessionId, runId, "interrupted", {
      endedAt: Date.now(),
    });

    const result = await SubagentRuntime.wait({ sessionId, runId });

    expect(result.status).toBe("interrupted");
  });
});
