import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { PolicyEngine, type PolicyEngineInstance } from "@openomni/agent";
import { Bus, Session, Storage, TranscriptStore } from "@openomni/session";
import type { Message, Transcript } from "@openomni/protocol";
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

function assistantInfo(sessionID: string, messageID: string): Message.AssistantMessage {
  return {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 1_000 },
    parentID: "user-1",
    modelID: "test-model",
    providerID: "test",
    agent: "worker",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

/** One complete tool-bearing worker turn recorded as transcript facts. */
function recordToolTurn(sessionID: string, messageID: string): void {
  const attemptId = `${messageID}#1`;
  const facts: Transcript.Fact[] = [
    { type: "message.created", attemptId, message: assistantInfo(sessionID, messageID) },
    {
      type: "part.appended",
      attemptId,
      messageId: messageID,
      part: {
        id: `${messageID}-text`,
        sessionID,
        messageID,
        type: "text",
        text: "",
        time: { start: 1_010 },
      },
    },
    {
      type: "part.advanced",
      attemptId,
      messageId: messageID,
      partId: `${messageID}-text`,
      transition: { to: "completed", at: 1_020, output: "worker turn output" },
    },
    {
      type: "part.appended",
      attemptId,
      messageId: messageID,
      part: {
        id: `${messageID}-tool`,
        sessionID,
        messageID,
        type: "tool",
        callID: `${messageID}-call`,
        tool: "bash",
        state: { status: "pending", input: { command: "ls" } },
      },
    },
    {
      type: "part.advanced",
      attemptId,
      messageId: messageID,
      partId: `${messageID}-tool`,
      transition: { to: "running", at: 1_030 },
    },
    {
      type: "part.advanced",
      attemptId,
      messageId: messageID,
      partId: `${messageID}-tool`,
      transition: { to: "completed", at: 1_040, output: "file-a", title: "bash" },
    },
    {
      type: "message.finished",
      attemptId,
      messageId: messageID,
      at: 1_050,
      finish: "stop",
      usage: { input: 12, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ];
  for (const fact of facts) TranscriptStore.record(sessionID, fact);
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
    queue.enqueue("run-1", { messageId: "msg-1", output: "first", timestamp: 1 }, "trace-1");
    queue.enqueue("run-1", { messageId: "msg-2", output: "second", timestamp: 2 }, "trace-1");

    const decision = await dispatchTurnFinish(queue, "run-1");

    expect(decision.effects).toEqual([
      { type: "prompt.inject_message", message: "first", role: "assistant" },
      { type: "prompt.inject_message", message: "second", role: "assistant" },
    ]);
    expect(queue.hasPending("run-1")).toBe(false);
  });

  it("persists only responses marked for history injection", async () => {
    const session = Session.create({
      traceId: "trace-1",
      title: "Policy Test",
      model: { providerID: "test", modelID: "test-model" },
    });
    const queue = InjectionQueue.create();
    queue.enqueue("run-1", { messageId: "msg-1", output: "transient", timestamp: 1 }, "trace-1");
    queue.enqueue(
      "run-1",
      {
        messageId: "msg-2",
        output: "durable",
        injectToHistory: true,
        timestamp: 2,
      },
      "trace-1",
    );

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

  // #562 F3 red pin: injected responses land in the SAME worker session that
  // records transcript facts. Resume replays the fact stream once one exists,
  // so a projection-only injected write silently vanishes from recovery. The
  // seam must record the injected response as synthesized facts.
  it("resume keeps injected responses in a fact-bearing session, in recording order", async () => {
    const session = Session.create({
      traceId: "trace-1",
      title: "Resume Merge",
      model: { providerID: "test", modelID: "test-model" },
    });
    recordToolTurn(session.id, "msg-turn");
    const queue = InjectionQueue.create();
    queue.enqueue(
      "run-resume",
      {
        messageId: "msg-injected",
        output: "resident answer",
        injectToHistory: true,
        timestamp: 2_000,
      },
      "trace-1",
    );

    await dispatchTurnFinish(queue, "run-resume", session.id);

    const recovered = await Session.resume(session.id);
    // Ordering rule: replay order is the session fact-stream seq (recording
    // order) — the injected response drains after the turn that asked for it.
    expect(recovered.map((entry) => entry.text)).toEqual(["worker turn output", "resident answer"]);
  });

  it("still emits drained responses when history persistence fails", async () => {
    const queue = InjectionQueue.create();
    queue.enqueue(
      "run-storage-failure",
      {
        messageId: "msg-storage-failure",
        output: "deliver despite storage failure",
        injectToHistory: true,
        timestamp: 4,
      },
      "trace-1",
    );
    const recordSpy = spyOn(TranscriptStore, "record").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    let decision: Awaited<ReturnType<typeof dispatchTurnFinish>>;
    try {
      decision = await dispatchTurnFinish(queue, "run-storage-failure", "session-storage-failure");
    } finally {
      recordSpy.mockRestore();
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

  it("drains under the run turn's trace — not the runId, not a mint (D11)", async () => {
    const queue = InjectionQueue.create();
    queue.enqueue(
      "traced-run",
      { messageId: "msg-traced", output: "payload", timestamp: 3 },
      "trace-enqueue",
    );
    const drainedEvents: Array<Record<string, unknown>> = [];
    const unsub = Bus.observe((event, data) => {
      if (event.name === "injection_queue.response.drained") {
        drainedEvents.push(data as Record<string, unknown>);
      }
    });
    const engine = PolicyEngine.create({ audit: false });
    engine.register(createInjectionQueueDrainPolicy(queue));

    await engine.dispatchPoint("run.turn.post", {
      ...baseContext("unused-run", "session-traced"),
      traceContext: { traceId: "trace-turn" },
      runId: "traced-run",
      sessionId: "session-traced",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drainedEvents).toEqual([
      { runId: "traced-run", traceId: "trace-turn", count: 1, time: expect.any(Number) },
    ]);
    unsub();
  });

  it("refuses to drain without the run trace and keeps the queue intact (D11)", async () => {
    const queue = InjectionQueue.create();
    queue.enqueue(
      "untraced-run",
      { messageId: "msg-untraced", output: "kept", injectToHistory: true, timestamp: 3 },
      "trace-1",
    );
    const engine = PolicyEngine.create({ audit: false });
    engine.register(createInjectionQueueDrainPolicy(queue));
    const context = {
      ...baseContext("unused-run", "session-untraced"),
      traceContext: undefined,
      runId: "untraced-run",
      sessionId: "session-untraced",
    };

    // The point is fail-open: the refusal surfaces as a bare allow with no
    // effects, and the injections stay queued for the next traced turn.
    const decision = await engine.dispatchPoint("run.turn.post", context);

    expect(decision.effects).toEqual([]);
    expect(queue.hasPending("untraced-run")).toBe(true);
  });

  it("uses canonical run and session identifiers over trace-context fields", async () => {
    const session = Session.create({
      traceId: "trace-1",
      title: "Legacy Context Policy Test",
      model: { providerID: "test", modelID: "test-model" },
    });
    const queue = InjectionQueue.create();
    queue.enqueue(
      "legacy-run",
      {
        messageId: "msg-legacy",
        output: "legacy durable",
        injectToHistory: true,
        timestamp: 3,
      },
      "trace-1",
    );
    const engine = PolicyEngine.create({ audit: false });
    engine.register(createInjectionQueueDrainPolicy(queue));
    // No TurnPostContext annotation: that union covers every policy point and
    // would erase the run.turn.post-specific `turnResult` the target requires.
    const context = {
      ...baseContext("unused-run", session.id),
      traceContext: { traceId: "trace-1" },
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
      "builtin:compaction",
      "builtin:tool-permission",
      "builtin:injection-queue-drain",
      "builtin:idle-nudge",
    ]);
  });
});
