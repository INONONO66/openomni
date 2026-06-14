import { afterEach, describe, expect, it } from "bun:test";
import { PolicyEngine } from "@openomni/agent";
import { Session, Storage } from "@openomni/session";
import { InjectionQueue } from "../../src/execution-runtime/injection-queue.js";
import { createInjectionQueueDrainPolicy } from "../../src/execution-runtime/middleware/injection-queue-policy.js";
import { buildWorkerMiddleware } from "../../src/execution-runtime/middleware.js";

function baseContext(runId: string, sessionId = "session-1") {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: true,
    continuationCount: 0,
    elapsedMs: 0,
    traceContext: { traceId: "trace-1", runId, sessionId, agentName: "main" },
  };
}

async function dispatchTurnFinish(
  queue: InjectionQueue.Instance,
  runId: string,
  sessionId?: string,
) {
  const engine = PolicyEngine.create({ audit: false });
  engine.register(createInjectionQueueDrainPolicy(queue));
  return engine.dispatch("turn.finish", baseContext(runId, sessionId));
}

describe("createInjectionQueueDrainPolicy", () => {
  afterEach(() => {
    Storage.reset();
  });

  it("is a turn.finish policy with priority before idle nudge", () => {
    const registration = createInjectionQueueDrainPolicy(InjectionQueue.create());

    expect(registration.name).toBe("builtin:injection-queue-drain");
    expect(registration.timing).toBe("turn.finish");
    expect(registration.priority).toBe(150);
  });

  it("does nothing when the run has no pending injected responses", async () => {
    const queue = InjectionQueue.create();

    const decision = await dispatchTurnFinish(queue, "run-empty");

    expect(decision.verdict).toBe("allow");
    expect(decision.effects).toEqual([]);
  });

  it("drains pending responses into prompt injection effects", async () => {
    const queue = InjectionQueue.create();
    queue.enqueue("run-1", { messageId: "msg-1", output: "first", timestamp: 1 });
    queue.enqueue("run-1", { messageId: "msg-2", output: "second", timestamp: 2 });

    const decision = await dispatchTurnFinish(queue, "run-1");

    expect(decision.effects).toEqual([
      { type: "prompt.inject_message", message: "first", role: "assistant" },
      { type: "prompt.inject_message", message: "second", role: "assistant" },
    ]);
    expect(queue.hasPending("run-1")).toBe(false);
  });

  it("persists only responses marked for history injection", async () => {
    const session = Session.create({
      title: "Policy Test",
      model: { providerID: "test", modelID: "test-model" },
    });
    const queue = InjectionQueue.create();
    queue.enqueue("run-1", { messageId: "msg-1", output: "transient", timestamp: 1 });
    queue.enqueue("run-1", {
      messageId: "msg-2",
      output: "durable",
      injectToHistory: true,
      timestamp: 2,
    });

    const decision = await dispatchTurnFinish(queue, "run-1", session.id);

    expect(decision.effects).toHaveLength(2);
    const messages = Session.getMessages(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "msg-2",
      sessionID: session.id,
      role: "assistant",
      agent: "main",
    });
    expect(Session.getParts("msg-2")).toEqual([
      expect.objectContaining({ type: "text", text: "durable", messageID: "msg-2" }),
    ]);
  });
});

describe("buildWorkerMiddleware injection queue integration", () => {
  it("includes injection queue drain policy when a queue is provided", () => {
    const registrations = buildWorkerMiddleware({ injectionQueue: InjectionQueue.create() });

    expect(registrations.map((registration) => registration.name)).toEqual([
      "builtin:budget-reassurance",
      "builtin:budget-warning",
      "builtin:tool-permission",
      "builtin:injection-queue-drain",
      "builtin:idle-nudge",
    ]);
  });
});
