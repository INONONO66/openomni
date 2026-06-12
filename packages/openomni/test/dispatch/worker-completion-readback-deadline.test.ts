import { beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";
import { reflectCoordinatorResult } from "../../src/dispatch/handlers/worker-completion";

function completionResult(readBackRequests: unknown[]) {
  return {
    runId: "run_1",
    sessionId: "session_1",
    status: "succeeded",
    output: JSON.stringify({
      completionReport: {
        summary: "Published the requested update.",
        claims: [{ statement: "The deployed page includes the expected marker." }],
      },
      readBackRequests,
    }),
  } as const;
}

async function createStartedWorkItem(): Promise<WorkItem.Info> {
  const workItem = await WorkItemStore.create({
    name: "Dispatch worker coder",
    sourceMessageId: "dispatch_1",
    sourceChannel: "dispatch",
    intent: "worker.spawn",
    goal: "publish it",
    executorKind: "internal_chat_agent",
    acceptanceCriteria: ["publish the marker"],
  });
  const started = await WorkItemStore.start(workItem.hash);
  if (!started) throw new Error("missing started work item");
  return started;
}

function citationRequest(target: string) {
  return {
    claimIndex: 0,
    request: {
      kind: "citation_match",
      target,
      quotedText: "expected completion marker",
    },
  } as const;
}

describe("worker completion read-back deadline", () => {
  beforeEach(() => {
    Storage.reset();
    Storage.initialize({ dbPath: ":memory:" });
  });

  test("applies one shared deadline across all read-back requests", async () => {
    const workItem = await createStartedWorkItem();
    let recorderCalls = 0;
    const clock = [0, 0, 11];

    const reflection = await reflectCoordinatorResult(
      workItem.hash,
      completionResult([
        citationRequest("http://example.com/first"),
        citationRequest("http://example.com/second"),
      ]),
      {
        readBackEnvelopeTimeoutMs: 10,
        now: () => clock.shift() ?? 11,
        async readBackRecorder(hash, request) {
          recorderCalls += 1;
          if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
          return WorkItemStore.addReadBackEvidence(hash, {
            kind: "citation_match",
            target: request.target,
            quotedText: request.quotedText,
            matchedText: request.quotedText,
            passed: true,
            observedAt: 1,
            statusCode: 200,
          });
        },
      },
    );

    const blocked = WorkItemStore.get(workItem.hash);
    expect(recorderCalls).toBe(1);
    expect(blocked ? WorkItem.deriveStatus(blocked) : undefined).toBe("blocked");
    expect(blocked?.evidence).toHaveLength(1);
    expect(blocked?.blockers[0]?.description).toBe("read-back envelope deadline exceeded");
    expect(reflection).toMatchObject({
      workItemStatus: "blocked",
      completionBlocked: true,
      completionBlocker: "read-back envelope deadline exceeded",
    });
  });

  test("rounds fractional envelope timeouts up to one millisecond", async () => {
    const workItem = await createStartedWorkItem();

    const reflection = await reflectCoordinatorResult(
      workItem.hash,
      completionResult([citationRequest("http://example.com/source")]),
      {
        readBackEnvelopeTimeoutMs: 0.25,
        now: () => 0,
        async readBackRecorder(hash, request) {
          if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
          expect(request.timeoutMs).toBe(1);
          expect(request.maxBodyBytes).toBe(1_000_000);
          return WorkItemStore.addReadBackEvidence(hash, {
            kind: "citation_match",
            target: request.target,
            quotedText: request.quotedText,
            matchedText: request.quotedText,
            passed: true,
            observedAt: 1,
            statusCode: 200,
          });
        },
      },
    );

    const completed = WorkItemStore.get(workItem.hash);
    expect(completed ? WorkItem.deriveStatus(completed) : undefined).toBe("completed");
    expect(reflection).toMatchObject({
      workItemStatus: "completed",
      completionBlocked: false,
    });
  });
});
