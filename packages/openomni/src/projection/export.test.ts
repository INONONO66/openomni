import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message, Transcript } from "@openomni/protocol";
import { WorkItem } from "@openomni/protocol";
import {
  Session,
  Storage,
  TranscriptStore,
  WorkItemAttemptRun,
  WorkItemStore,
} from "@openomni/ledger";
import { ProjectionExportError, exportWorkItemProjection } from "./export";
import { FLAT_EVENT_FIELDS } from "./flat-event";
import { createInMemorySidecarStore } from "./sidecar-store";

function attemptIdentity() {
  return {
    contentFingerprint: WorkItem.contentFingerprintOf({
      workInput: "export projection",
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true as const, reason: "test fixture" },
      model: {
        provider: "test",
        id: "model-1",
        parameters: { absent: true as const, reason: "test fixture" },
      },
      upstreamFingerprints: { absent: true as const, reason: "test fixture" },
      dependencyLock: { absent: true as const, reason: "test fixture" },
    }),
    environmentFingerprint: WorkItem.environmentFingerprintOf({
      os: "darwin",
      arch: "arm64",
      bunVersion: "1.3.0",
      workspaceRoot: { absent: true, reason: "test fixture" },
      schemaVersions: { protocol: 1 },
      policy: { absent: true, reason: "test fixture" },
      toolVersions: { absent: true, reason: "test fixture" },
      verifierVersions: { absent: true, reason: "test fixture" },
      providerParameters: { absent: true, reason: "test fixture" },
      configRef: { absent: true, reason: "test fixture" },
    }),
  };
}

function assistant(sessionID: string, suffix = "export"): Message.AssistantMessage {
  return {
    id: `message-${suffix}`,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "user-1",
    modelID: `model-${suffix}`,
    providerID: "test",
    agent: "agent-1",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function transcriptFacts(sessionID: string, suffix = "export"): Transcript.Fact[] {
  const message = assistant(sessionID, suffix);
  const llmAttemptId = `llm-${suffix}`;
  return [
    { type: "message.created", attemptId: llmAttemptId, message },
    {
      type: "part.appended",
      attemptId: llmAttemptId,
      messageId: message.id,
      part: {
        id: `tool-${suffix}`,
        sessionID,
        messageID: message.id,
        type: "tool",
        callID: `call-${suffix}`,
        tool: "bash",
        state: { status: "pending", input: { command: "pwd" } },
      },
    },
    {
      type: "part.advanced",
      attemptId: llmAttemptId,
      messageId: message.id,
      partId: `tool-${suffix}`,
      transition: { to: "running", at: Date.now() },
    },
    {
      type: "part.advanced",
      attemptId: llmAttemptId,
      messageId: message.id,
      partId: `tool-${suffix}`,
      transition: { to: "completed", at: Date.now(), output: "/tmp", title: "pwd" },
    },
    {
      type: "message.finished",
      attemptId: llmAttemptId,
      messageId: message.id,
      at: Date.now(),
      finish: "stop",
      usage: { input: 5, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ];
}

function capturedNotFound(act: () => unknown): ProjectionExportError {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionExportError);
    return error as ProjectionExportError;
  }
  throw new Error("expected ProjectionExportError");
}

describe("exportWorkItemProjection", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  afterEach(() => Storage.reset());

  test("exports deterministic ordered JSONL and resolvable observations", async () => {
    const session = Session.create({
      traceId: "trace-export",
      title: "projection export",
      model: { providerID: "test", modelID: "model-1" },
    });
    const item = await WorkItemStore.create(
      {
        name: "projection export",
        sourceMessageId: "source-export",
        sourceChannel: "test",
        sessionId: session.id,
        intent: "test",
        goal: "export recorded facts",
        acceptanceCriteria: ["the JSONL is deterministic"],
      },
      "trace-export",
    );
    const allocation = await WorkItemStore.allocateAttempt(
      item.workItemId,
      attemptIdentity(),
      "trace-export",
    );
    if (allocation === undefined) throw new Error("expected attempt allocation");
    for (const fact of transcriptFacts(session.id)) TranscriptStore.record(session.id, fact);

    const sidecar = createInMemorySidecarStore();
    const first = exportWorkItemProjection(item.workItemId, sidecar);
    const second = exportWorkItemProjection(item.workItemId, sidecar);
    const lines = first.jsonl.trimEnd().split("\n");

    expect(lines).toHaveLength(first.rows.length);
    expect(Object.keys(JSON.parse(lines[0] ?? "{}"))).toEqual(FLAT_EVENT_FIELDS);
    expect(second.jsonl).toBe(first.jsonl);
    expect(first.sidecarDigests).toHaveLength(1);
    const digest = first.sidecarDigests[0];
    if (digest === undefined) throw new Error("expected sidecar digest");
    expect(sidecar.getText(digest as Parameters<typeof sidecar.getText>[0])).toBe("/tmp");
  });

  test("exports two WorkItems sharing one session as correct disjoint windows", async () => {
    const originalNow = Date.now;
    let now = 10;
    Date.now = () => now;
    try {
      const session = Session.create({
        traceId: "trace-shared",
        title: "shared projection session",
        model: { providerID: "test", modelID: "model-shared" },
      });
      now = 20;
      const first = await WorkItemStore.create(
        {
          name: "first projection",
          sourceMessageId: "source-first",
          sourceChannel: "test",
          sessionId: session.id,
          workSessionId: session.id,
          workerRunId: "run-first",
          executorKind: "internal_chat_agent",
          intent: "test",
          goal: "export first window",
          acceptanceCriteria: ["the first export is disjoint"],
        },
        "trace-shared",
      );
      now = 30;
      await WorkItemStore.start(first.workItemId, "trace-shared");
      now = 40;
      const firstAllocation = await WorkItemStore.allocateAttempt(
        first.workItemId,
        attemptIdentity(),
        "trace-shared",
      );
      if (firstAllocation === undefined) throw new Error("expected first allocation");
      now = 50;
      for (const fact of transcriptFacts(session.id, "first")) {
        TranscriptStore.record(session.id, fact);
      }
      now = 60;
      await WorkItemAttemptRun.finish(session.id, "run-first", "succeeded", "trace-shared", {
        endedAt: now,
      });

      now = 100;
      const second = await WorkItemStore.create(
        {
          name: "second projection",
          sourceMessageId: "source-second",
          sourceChannel: "test",
          sessionId: session.id,
          workSessionId: session.id,
          workerRunId: "run-second",
          executorKind: "internal_chat_agent",
          intent: "test",
          goal: "export second window",
          acceptanceCriteria: ["the second export is disjoint"],
        },
        "trace-shared",
      );
      now = 110;
      await WorkItemStore.start(second.workItemId, "trace-shared");
      now = 120;
      const secondAllocation = await WorkItemStore.allocateAttempt(
        second.workItemId,
        attemptIdentity(),
        "trace-shared",
      );
      if (secondAllocation === undefined) throw new Error("expected second allocation");
      now = 130;
      for (const fact of transcriptFacts(session.id, "second")) {
        TranscriptStore.record(session.id, fact);
      }
      now = 140;
      await WorkItemAttemptRun.finish(session.id, "run-second", "succeeded", "trace-shared", {
        endedAt: now,
      });

      const sidecar = createInMemorySidecarStore();
      const firstExport = exportWorkItemProjection(first.workItemId, sidecar);
      const secondExport = exportWorkItemProjection(second.workItemId, sidecar);

      expect(firstExport.rows).toHaveLength(5);
      expect(secondExport.rows).toHaveLength(5);
      expect(firstExport.rows.map((row) => row.step)).toEqual([1, 2, 3, 4, 5]);
      expect(secondExport.rows.map((row) => row.step)).toEqual([6, 7, 8, 9, 10]);
      expect(firstExport.rows.find((row) => row.model !== null)?.model).toBe("model-first");
      expect(secondExport.rows.find((row) => row.model !== null)?.model).toBe("model-second");
      expect(
        firstExport.rows.every((row) => row.attempt_id === firstAllocation.attempt.attemptId),
      ).toBe(true);
      expect(
        secondExport.rows.every((row) => row.attempt_id === secondAllocation.attempt.attemptId),
      ).toBe(true);
    } finally {
      Date.now = originalNow;
    }
  });

  test("throws a typed not-found error", () => {
    const error = capturedNotFound(() =>
      exportWorkItemProjection("missing", createInMemorySidecarStore()),
    );
    expect(error.reason).toBe("work_item_not_found");
    expect(error.workItemId).toBe("missing");
  });
});
