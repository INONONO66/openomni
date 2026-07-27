import { afterEach, beforeEach, expect, test } from "bun:test";
import { IngressEvent } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import { IngressEngine } from "../../src/ingress/engine";
import type {
  MessagingLedgerService,
  MessagingSessionInfo,
} from "../../src/ingress/session-resolver";
import { ResidentRuntime } from "../../src/resident/runtime";
import { createTestLlmEnvironment } from "../helpers/llm-environment";

type TranscriptMessage = {
  role: "user" | "assistant";
  parts: Array<{ type: string; text?: string }>;
};

function createInMemoryMessagingLedgerService(): MessagingLedgerService {
  const sessions = new Map<string, MessagingSessionInfo>();
  const transcripts = new Map<string, TranscriptMessage[]>();
  const transcriptFor = (sessionId: string): TranscriptMessage[] => {
    const existing = transcripts.get(sessionId);
    if (existing !== undefined) return existing;
    const created: TranscriptMessage[] = [];
    transcripts.set(sessionId, created);
    return created;
  };

  return {
    execute(command) {
      if (command.kind === "MS-01") {
        transcriptFor(command.sessionId).push({
          role: "user",
          parts: [{ type: "text", text: command.text }],
        });
        return { status: "committed" };
      }
      if (command.kind === "MS-06") {
        transcriptFor(command.sessionId).push({
          role: "assistant",
          parts: [{ type: "text", text: command.text }],
        });
        return { status: "committed" };
      }

      const existing = sessions.get(command.sessionId);
      if (existing !== undefined) {
        return { status: "committed", session: existing, isNew: false };
      }
      const now = command.openedAt;
      const session: MessagingSessionInfo = {
        id: command.sessionId,
        title: command.title,
        model: command.model,
        time: { created: now, updated: now },
        ...(command.kind === "SS-02"
          ? { parentID: command.parentSessionId, workerMeta: command.workerMeta }
          : {}),
      };
      sessions.set(command.sessionId, session);
      transcriptFor(command.sessionId);
      return { status: "committed", session, isNew: true };
    },
    query(request) {
      if (request.kind === "session") {
        return { kind: "session", session: sessions.get(request.sessionId) ?? null };
      }
      return { kind: "transcript", messages: transcriptFor(request.sessionId) };
    },
  };
}

beforeEach(() => {
  IngressEngine.setMessagingLedgerService(createInMemoryMessagingLedgerService());
});

afterEach(() => {
  IngressEngine.clearMessagingLedgerService();
});

function makeEvent() {
  return {
    id: crypto.randomUUID(),
    surface: "slack",
    payload: "hello",
    mode: "direct" as const,
    meta: { target: { kind: "resident" as const } },
    agent: { model: { provider: "test", id: "fixture" } },
  };
}

test("ResidentRuntime enforces maximum resident activations", async () => {
  let markFirstRunStarted!: () => void;
  let releaseFirstRun!: () => void;
  const firstRunStarted = new Promise<void>((resolve) => {
    markFirstRunStarted = resolve;
  });
  const firstRunCanFinish = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  const manager = ResidentRuntime.create({
    ...createTestLlmEnvironment(),
    maxActive: 1,
    idleTimeoutMs: 1_000,
    runAgent: async () => {
      markFirstRunStarted();
      await firstRunCanFinish;
      return { text: "ok", finishReason: "stop" };
    },
  });

  const firstRun = manager.run({ sessionId: "resident-a", event: makeEvent() });
  await firstRunStarted;

  const secondError = await manager
    .run({ sessionId: "resident-b", event: makeEvent() })
    .catch((error) => error);
  expect(secondError).toBeInstanceOf(Error);
  if (!(secondError instanceof Error)) throw new TypeError("expected resident activation error");
  expect(secondError.message).toContain("maximum resident activations reached");

  releaseFirstRun();
  await firstRun;
});

test("ResidentRuntime reuses fallback traceId for agent input and completion event", async () => {
  let inputTraceId: string | undefined;
  const completedTraceIds: string[] = [];
  const unsubscribe = Bus.subscribe(IngressEvent.Completed, (event) => {
    completedTraceIds.push(event.traceId);
  });

  const manager = ResidentRuntime.create({
    ...createTestLlmEnvironment(),
    runAgent: async (_config, input) => {
      inputTraceId = input.traceContext?.traceId;
      return { text: "ok", finishReason: "stop" };
    },
  });

  try {
    await manager.run({ sessionId: "resident-trace", event: makeEvent() });
  } finally {
    unsubscribe();
  }

  expect(inputTraceId).toBeString();
  expect(completedTraceIds.at(-1)).toBe(inputTraceId);
});

test("ResidentRuntime does not start a queued run after it is aborted", async () => {
  let releaseFirstRun!: () => void;
  let firstRunStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstRunStarted = resolve;
  });
  const firstCanFinish = new Promise<void>((resolve) => {
    releaseFirstRun = resolve;
  });
  let runCount = 0;
  const manager = ResidentRuntime.create({
    ...createTestLlmEnvironment(),
    runAgent: async () => {
      runCount++;
      if (runCount === 1) {
        firstRunStarted();
        await firstCanFinish;
      }
      return { text: "ok", finishReason: "stop" };
    },
  });

  const firstRun = manager.run({ sessionId: "resident-queued-abort", event: makeEvent() });
  await firstStarted;

  const controller = new AbortController();
  const secondRun = manager.run({
    sessionId: "resident-queued-abort",
    event: makeEvent(),
    signal: controller.signal,
  });

  controller.abort();
  const secondError = await secondRun.catch((error) => error);
  expect(secondError).toBeInstanceOf(Error);
  expect((secondError as Error).name).toBe("AbortError");

  releaseFirstRun();
  await firstRun;
  await Bun.sleep(0);
  expect(runCount).toBe(1);
});
