import { afterEach, describe, expect, it } from "bun:test";
import { AgentExecution, type Message } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Compaction } from "../../src/compaction/compact";

/**
 * The lock bracket: every compact() call publishes exactly one
 * `agent.compaction.started` before any work and exactly one
 * `agent.compaction.completed` as its last record — on every exit path,
 * including a summarizer throw. A started without a completed therefore
 * means the run died inside compaction, which is precisely the diagnosis
 * that was impossible while the only records were success-path ephemerals.
 */

const IDENTITY = {
  traceId: "trace-bracket-test",
  sessionId: "session-bracket-test",
  runId: "run-bracket-test",
} as const;

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function makeUserMessage(text: string): Message.WithParts {
  const id = nextId("user-message");
  const sessionID = IDENTITY.sessionId;
  const info: Message.UserMessage = {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "", modelID: "" },
  };
  const part: Message.TextPart = {
    id: nextId("user-part"),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [part] };
}

function makeAssistantMessage(text: string): Message.WithParts {
  const id = nextId("assistant-message");
  const sessionID = IDENTITY.sessionId;
  const info: Message.AssistantMessage = {
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "",
    modelID: "",
    providerID: "",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  const part: Message.TextPart = {
    id: nextId("assistant-part"),
    sessionID,
    messageID: id,
    type: "text",
    text,
  };
  return { info, parts: [part] };
}

interface StartedEvent {
  traceId: string;
  sessionId: string;
  runId?: string;
  messagesBefore: number;
  trigger: string;
  summarizer: boolean;
}

interface CompletedEvent {
  traceId: string;
  sessionId: string;
  runId?: string;
  outcome: string;
  messagesBefore: number;
  messagesAfter: number;
  removedCount: number;
  elidedChars: number;
  error?: string;
}

function captureBracket(): {
  started: StartedEvent[];
  completed: CompletedEvent[];
  order: string[];
  unsubscribe: () => void;
} {
  const started: StartedEvent[] = [];
  const completed: CompletedEvent[] = [];
  const order: string[] = [];
  const unsubStarted = Bus.subscribe(AgentExecution.CompactionStarted, (event) => {
    started.push(event as unknown as StartedEvent);
    order.push("started");
  });
  const unsubCompleted = Bus.subscribe(AgentExecution.CompactionCompleted, (event) => {
    completed.push(event as unknown as CompletedEvent);
    order.push("completed");
  });
  return {
    started,
    completed,
    order,
    unsubscribe: () => {
      unsubStarted();
      unsubCompleted();
    },
  };
}

describe("Compaction bracket", () => {
  afterEach(() => {
    Bus.reset();
  });

  it("brackets a cut: one started, one completed(cut), completed last", async () => {
    const capture = captureBracket();
    try {
      const result = await Compaction.compact(
        Array.from({ length: 12 }, (_unused, index) => makeUserMessage(`message ${index}`)),
        { contextWindowTokens: 1000, protectRecentMessages: 2 },
        IDENTITY,
        Bus,
        { trigger: "threshold" },
      );
      await Bun.sleep(0);

      expect(result.compacted).toBe(true);
      expect(capture.started).toHaveLength(1);
      expect(capture.completed).toHaveLength(1);
      expect(capture.order).toEqual(["started", "completed"]);
      expect(capture.started[0]).toMatchObject({
        traceId: IDENTITY.traceId,
        sessionId: IDENTITY.sessionId,
        messagesBefore: 12,
        trigger: "threshold",
        summarizer: false,
      });
      expect(capture.completed[0]).toMatchObject({
        traceId: IDENTITY.traceId,
        sessionId: IDENTITY.sessionId,
        outcome: "cut",
      });
      // #702 rider: when the caller supplies a runId, the bracket records it.
      expect(capture.started[0]?.runId).toBe(IDENTITY.runId);
      expect(capture.completed[0]?.runId).toBe(IDENTITY.runId);
      expect(capture.completed[0]?.removedCount).toBeGreaterThan(0);
    } finally {
      capture.unsubscribe();
    }
  });

  it("a summarizer throw still closes the bracket as failed, then propagates", async () => {
    const capture = captureBracket();
    try {
      const attempt = Compaction.compact(
        // Mixed roles: user messages never reach the summarizer (L2), so an
        // all-user span would skip the summarize call this test needs to throw.
        Array.from({ length: 12 }, (_unused, index) =>
          index % 2 === 0 ? makeUserMessage(`message ${index}`) : makeAssistantMessage(`a${index}`),
        ),
        {
          contextWindowTokens: 1000,
          protectRecentMessages: 2,
          onSummarize: () => Promise.reject(new Error("summarizer exploded")),
        },
        IDENTITY,
        Bus,
        { trigger: "threshold" },
      );
      await expect(attempt).rejects.toThrow("summarizer exploded");
      await Bun.sleep(0);

      expect(capture.started).toHaveLength(1);
      expect(capture.completed).toHaveLength(1);
      expect(capture.completed[0]?.outcome).toBe("failed");
      expect(String(capture.completed[0]?.error)).toContain("summarizer exploded");
      expect(capture.order).toEqual(["started", "completed"]);
    } finally {
      capture.unsubscribe();
    }
  });

  it("brackets the refused cut: completed(no_user_boundary)", async () => {
    const capture = captureBracket();
    try {
      const result = await Compaction.compact(
        Array.from({ length: 12 }, (_unused, index) => makeAssistantMessage(`assistant ${index}`)),
        { contextWindowTokens: 1000, protectRecentMessages: 2 },
        IDENTITY,
        Bus,
        { trigger: "yield" },
      );
      await Bun.sleep(0);

      expect(result.compacted).toBe(false);
      expect(result.blocked).toBe("no_user_boundary");
      expect(capture.started).toHaveLength(1);
      expect(capture.started[0]?.trigger).toBe("yield");
      expect(capture.completed).toHaveLength(1);
      expect(capture.completed[0]?.outcome).toBe("no_user_boundary");
    } finally {
      capture.unsubscribe();
    }
  });

  it("brackets the trivial no-op: completed(nothing_reclaimed)", async () => {
    const capture = captureBracket();
    try {
      const result = await Compaction.compact(
        [makeUserMessage("only one")],
        { contextWindowTokens: 1000, protectRecentMessages: 6 },
        IDENTITY,
        Bus,
        { trigger: "threshold" },
      );
      await Bun.sleep(0);

      expect(result.compacted).toBe(false);
      expect(capture.started).toHaveLength(1);
      expect(capture.completed).toHaveLength(1);
      expect(capture.completed[0]?.outcome).toBe("nothing_reclaimed");
    } finally {
      capture.unsubscribe();
    }
  });
});
