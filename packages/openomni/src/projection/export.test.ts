import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message, Transcript } from "@openomni/protocol";
import { WorkItem } from "@openomni/protocol";
import { Session, Storage, TranscriptStore, WorkItemStore } from "@openomni/ledger";
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

function assistant(sessionID: string): Message.AssistantMessage {
  return {
    id: "message-export",
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: "user-1",
    modelID: "model-1",
    providerID: "test",
    agent: "agent-1",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function transcriptFacts(sessionID: string): Transcript.Fact[] {
  const message = assistant(sessionID);
  return [
    { type: "message.created", attemptId: "llm-export", message },
    {
      type: "part.appended",
      attemptId: "llm-export",
      messageId: message.id,
      part: {
        id: "tool-export",
        sessionID,
        messageID: message.id,
        type: "tool",
        callID: "call-export",
        tool: "bash",
        state: { status: "pending", input: { command: "pwd" } },
      },
    },
    {
      type: "part.advanced",
      attemptId: "llm-export",
      messageId: message.id,
      partId: "tool-export",
      transition: { to: "running", at: Date.now() },
    },
    {
      type: "part.advanced",
      attemptId: "llm-export",
      messageId: message.id,
      partId: "tool-export",
      transition: { to: "completed", at: Date.now(), output: "/tmp", title: "pwd" },
    },
    {
      type: "message.finished",
      attemptId: "llm-export",
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
    expect(sidecar.getText(digest as Parameters<typeof sidecar.getText>[0])).toBe(
      JSON.stringify("/tmp"),
    );
  });

  test("throws a typed not-found error", () => {
    const error = capturedNotFound(() =>
      exportWorkItemProjection("missing", createInMemorySidecarStore()),
    );
    expect(error.reason).toBe("work_item_not_found");
    expect(error.workItemId).toBe("missing");
  });
});
