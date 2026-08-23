import { describe, expect, test } from "bun:test";
import type { Ledger, Message, Transcript, WorkItem } from "@openomni/protocol";
import { WorkItem as WorkItemSchema } from "@openomni/protocol";
import type { Storage } from "@openomni/ledger";
import { assembleProjectionInput, ProjectionAssemblyError } from "./assembler";
import { createInMemorySidecarStore } from "./sidecar-store";

function fingerprintInputs(workInput: string) {
  return {
    contentFingerprint: WorkItemSchema.contentFingerprintOf({
      workInput,
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true as const, reason: "test fixture" },
      model: {
        provider: "test",
        id: "model",
        parameters: { absent: true as const, reason: "test fixture" },
      },
      upstreamFingerprints: { absent: true as const, reason: "test fixture" },
      dependencyLock: { absent: true as const, reason: "test fixture" },
    }),
    environmentFingerprint: WorkItemSchema.environmentFingerprintOf({
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

function attempt(attemptId: string, attemptSeq: number): WorkItem.Attempt {
  return WorkItemSchema.Attempt.parse({
    attemptId,
    attemptSeq,
    retryOf: attemptSeq === 1 ? null : "attempt-1",
    reusedFromAttemptId: null,
    ...fingerprintInputs(`work-${attemptSeq}`),
  });
}

function workItem(): WorkItem.Info {
  const workItemId = "wi-projection";
  const statement = "projection is assembled";
  return WorkItemSchema.Info.parse({
    workItemId,
    revision: 1,
    name: "projection",
    sourceMessageId: "source-1",
    sourceChannel: "test",
    sessionId: "session-1",
    attempt: 1,
    lastAttemptSeq: 0,
    timestamps: { created: 1, updated: 1 },
    relations: { childIds: [], dependsOn: [] },
    intent: "test",
    goal: "test projection",
    constraints: [],
    acceptanceCriteria: [statement],
    changedFiles: [],
    blockers: [],
    evidence: [],
    completionContract: { version: 1, revision: "1", basisRef: `${workItemId}:attempt:1` },
    completionFacts: {
      ...WorkItemSchema.emptyCompletionFacts(),
      criteria: [
        {
          id: WorkItemSchema.criterionId(workItemId, 0, statement),
          revision: 1,
          statement,
          required: true,
        },
      ],
    },
  });
}

function allocation(
  identity: WorkItem.Attempt,
  timeCreated: number,
  seq: number,
): Ledger.RecordedFact {
  return {
    streamId: "work:wi-projection",
    seq,
    type: "work_item.attempt_allocated",
    data: { ...identity, revision: seq },
    timeCreated,
  };
}

function assistantMessage(): Message.AssistantMessage {
  return {
    id: "message-1",
    sessionID: "session-1",
    role: "assistant",
    time: { created: 100 },
    parentID: "user-1",
    modelID: "model-1",
    providerID: "test",
    agent: "agent-1",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function row(fact: Transcript.Fact, timeCreated: number, seq: number): Storage.TranscriptFactRow {
  return {
    sessionID: "session-1",
    seq,
    messageID: fact.type === "message.created" ? fact.message.id : fact.messageId,
    attemptID: fact.attemptId,
    type: fact.type,
    data: JSON.stringify(fact),
    timeCreated,
  };
}

const created: Transcript.Fact = {
  type: "message.created",
  attemptId: "llm-attempt",
  message: assistantMessage(),
};

function materials(transcriptRows: Storage.TranscriptFactRow[]) {
  return {
    workItem: workItem(),
    attemptFacts: [allocation(attempt("attempt-1", 1), 10, 2)],
    transcriptRows,
  };
}

function capturedError(act: () => unknown): ProjectionAssemblyError {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectionAssemblyError);
    return error as ProjectionAssemblyError;
  }
  throw new Error("expected ProjectionAssemblyError");
}

describe("assembleProjectionInput", () => {
  test("attributes steps to the latest allocated WorkItem attempt window", () => {
    const first = attempt("attempt-1", 1);
    const second = attempt("attempt-2", 2);
    const input = assembleProjectionInput(
      {
        workItem: workItem(),
        attemptFacts: [allocation(first, 10, 2), allocation(second, 30, 3)],
        transcriptRows: [row(created, 20, 1), row(created, 40, 2)],
      },
      createInMemorySidecarStore(),
    );

    expect(input.steps.map((step) => step.attempt.attemptId)).toEqual([
      first.attemptId,
      second.attemptId,
    ]);
  });

  test("throws a typed error when a step predates the first allocation", () => {
    const error = capturedError(() =>
      assembleProjectionInput(materials([row(created, 5, 1)]), createInMemorySidecarStore()),
    );
    expect(error.reason).toBe("step_before_first_attempt");
  });

  test("maps tool input and completed output through the sidecar", () => {
    const store = createInMemorySidecarStore();
    const tool: Transcript.Fact = {
      type: "part.appended",
      attemptId: "llm-attempt",
      messageId: "message-1",
      part: {
        id: "tool-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "pwd" },
          output: "/tmp",
          title: "pwd",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    };
    const input = assembleProjectionInput(materials([row(tool, 20, 1)]), store);
    const [step] = input.steps;

    expect(step?.action).toBe("bash");
    expect(step?.actionArgs).toEqual({ command: "pwd" });
    expect(step?.observationHash).not.toBeNull();
    if (step?.observationHash === null || step?.observationHash === undefined) {
      throw new Error("expected observation digest");
    }
    expect(store.getText(step.observationHash as Parameters<typeof store.getText>[0])).toBe(
      JSON.stringify("/tmp"),
    );
  });

  test("maps text and message-finished telemetry", () => {
    const text: Transcript.Fact = {
      type: "part.appended",
      attemptId: "llm-attempt",
      messageId: "message-1",
      part: {
        id: "text-1",
        sessionID: "session-1",
        messageID: "message-1",
        type: "text",
        text: "thinking",
      },
    };
    const finished: Transcript.Fact = {
      type: "message.finished",
      attemptId: "llm-attempt",
      messageId: "message-1",
      at: 30,
      finish: "length",
      usage: { input: 12, output: 7, reasoning: 3, cache: { read: 1, write: 0 } },
    };
    const input = assembleProjectionInput(
      materials([row(text, 20, 1), row(finished, 30, 2)]),
      createInMemorySidecarStore(),
    );

    expect(input.steps[0]?.thought).toBe("thinking");
    expect(input.steps[1]).toMatchObject({ inTokens: 12, outTokens: 7, finishReason: "length" });
  });

  test("returns empty input for empty material and fails loudly on corrupt JSON", () => {
    expect(
      assembleProjectionInput(
        { workItem: workItem(), attemptFacts: [], transcriptRows: [] },
        createInMemorySidecarStore(),
      ),
    ).toEqual({ steps: [] });

    const corrupt = { ...row(created, 20, 1), data: "{" };
    const error = capturedError(() =>
      assembleProjectionInput(materials([corrupt]), createInMemorySidecarStore()),
    );
    expect(error.reason).toBe("corrupt_fact");
  });
});
