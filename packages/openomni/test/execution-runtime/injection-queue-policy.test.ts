import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PolicyEngine, type PolicyEngineInstance } from "@openomni/agent";
import { Session, Storage } from "@openomni/session";
import { InjectionQueue } from "../../src/execution-runtime/injection-queue.js";
import { createInjectionQueueDrainPolicy } from "../../src/execution-runtime/middleware/injection-queue-policy.js";
import { buildWorkerMiddleware } from "../../src/execution-runtime/middleware.js";

type TurnPostContext = Parameters<PolicyEngineInstance["dispatchPoint"]>[1];

function baseContext(runId: string, sessionId = "session-1") {
  return {
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    turnCount: 0,
    isCompletion: true,
    continuationCount: 0,
    elapsedMs: 0,
    sessionId,
    runId,
    turnIndex: 0,
    turnResult: { type: "stop" },
    traceContext: { traceId: "trace-1", runId, sessionId, agentName: "main" },
  } satisfies TurnPostContext;
}

async function dispatchTurnFinish(
  queue: InjectionQueue.Instance,
  runId: string,
  sessionId?: string,
) {
  const engine = PolicyEngine.create({ audit: false });
  engine.register(createInjectionQueueDrainPolicy(queue));
  return engine.dispatchPoint("run.turn.post", baseContext(runId, sessionId));
}

describe("createInjectionQueueDrainPolicy", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => {
    Storage.reset();
  });

  it("declares the run.turn.post point and only prompt injection effects", () => {
    const registration = createInjectionQueueDrainPolicy(InjectionQueue.create());

    expect(registration.name).toBe("builtin:injection-queue-drain");
    expect(registration.kind).toBe("point");
    expect(registration.pointIds).toEqual(["run.turn.post"]);
    expect(registration.effectCapabilities).toEqual({
      "run.turn.post": ["prompt.inject_message"],
    });
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

  it("still emits drained responses when history persistence fails", async () => {
    const queue = InjectionQueue.create();
    queue.enqueue("run-storage-failure", {
      messageId: "msg-storage-failure",
      output: "deliver despite storage failure",
      injectToHistory: true,
      timestamp: 4,
    });
    const addMessageSpy = spyOn(Session, "addMessage").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    let decision: Awaited<ReturnType<typeof dispatchTurnFinish>>;
    try {
      decision = await dispatchTurnFinish(queue, "run-storage-failure", "session-storage-failure");
    } finally {
      addMessageSpy.mockRestore();
    }

    expect(decision.effects).toEqual([
      {
        type: "prompt.inject_message",
        message: "deliver despite storage failure",
        role: "assistant",
      },
    ]);
    expect(queue.hasPending("run-storage-failure")).toBe(false);
  });

  it("uses canonical run and session identifiers when trace context is absent", async () => {
    const session = Session.create({
      title: "Legacy Context Policy Test",
      model: { providerID: "test", modelID: "test-model" },
    });
    const queue = InjectionQueue.create();
    queue.enqueue("legacy-run", {
      messageId: "msg-legacy",
      output: "legacy durable",
      injectToHistory: true,
      timestamp: 3,
    });
    const engine = PolicyEngine.create({ audit: false });
    engine.register(createInjectionQueueDrainPolicy(queue));
    const context: TurnPostContext = {
      ...baseContext("unused-run", session.id),
      traceContext: undefined,
      runId: "legacy-run",
      sessionId: session.id,
    };

    const decision = await engine.dispatchPoint("run.turn.post", context);

    expect(decision.effects).toEqual([
      { type: "prompt.inject_message", message: "legacy durable", role: "assistant" },
    ]);
    expect(queue.hasPending("legacy-run")).toBe(false);
    expect(Session.getMessages(session.id)[0]).toMatchObject({
      id: "msg-legacy",
      sessionID: session.id,
      agent: "injection-queue",
    });
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
