import { beforeEach, describe, expect, test } from "bun:test";
import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision, WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";
import {
  reflectCoordinatorResult as reflectCoordinatorResultWithPolicy,
  type WorkerCompletionOptions,
} from "../../src/dispatch/handlers/worker-completion";

const COMPLETION_POLICY_ENGINE = PolicyEngine.create();
let completionWriter: Storage.WorkItemCompletionWriter;

function reflectCoordinatorResult(
  workItemHash: string,
  result: Parameters<typeof reflectCoordinatorResultWithPolicy>[1],
  options: Omit<WorkerCompletionOptions, "completionPolicyEngine">,
) {
  return reflectCoordinatorResultWithPolicy(workItemHash, result, {
    completionWriter,
    ...options,
    completionPolicyEngine: COMPLETION_POLICY_ENGINE,
  });
}

function completionResult(item: WorkItem.Info, readBackRequests: unknown[]) {
  const criterion = item.completionFacts.criteria[0];
  if (!criterion) throw new Error("missing completion criterion");
  return {
    runId: "run_1",
    sessionId: "session_1",
    status: "succeeded",
    output: JSON.stringify({
      completionReport: {
        summary: "Published the requested update.",
        claims: [{ statement: criterion.statement }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
      ],
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
    workSessionId: "session_1",
    workerRunId: "run_1",
    acceptanceCriteria: ["archived source contains the recorded quote exactly"],
  });
  const started = await WorkItemStore.start(workItem.hash);
  if (!started) throw new Error("missing started work item");
  return started;
}

function citationRequest(target: string) {
  return {
    claimIndex: 0,
    criterionIndex: 0,
    request: {
      kind: "citation_match",
      target,
      quotedText: "expected completion marker",
    },
  } as const;
}

function successfulReadBackRecorder(_hash: string, request: WorkItem.ReadBackRequest) {
  if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
  return WorkItem.ReadBackCheck.parse({
    kind: "citation_match",
    target: request.target,
    quotedText: request.quotedText,
    matchedText: request.quotedText,
    passed: true,
    observedAt: 1,
    statusCode: 200,
  });
}

describe("worker completion read-back deadline", () => {
  beforeEach(() => {
    Storage.reset();
    completionWriter = Storage.initialize({ dbPath: ":memory:" });
  });

  test("applies one shared deadline across all read-back requests", async () => {
    const workItem = await createStartedWorkItem();
    let recorderCalls = 0;
    const clock = [0, 0, 0, 0, 11];

    const reflection = await reflectCoordinatorResult(
      workItem.hash,
      completionResult(workItem, [
        citationRequest("http://example.com/first"),
        citationRequest("http://example.com/second"),
      ]),
      {
        sourceOrigin: { source: "internal_worker" },
        readBackEnvelopeTimeoutMs: 10,
        now: () => clock.shift() ?? 11,
        async readBackRecorder(_hash, request) {
          recorderCalls += 1;
          if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
          return WorkItem.ReadBackCheck.parse({
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
    expect(blocked?.evidence).toHaveLength(0);
    expect(blocked?.blockers[0]?.description).toBe("read-back envelope deadline exceeded");
    expect(reflection).toMatchObject({
      workItemStatus: "blocked",
      completionBlocked: true,
      completionBlocker: "read-back envelope deadline exceeded",
    });
  });

  test("bounds a non-settling read-back recorder by the shared deadline", async () => {
    const workItem = await createStartedWorkItem();

    const reflection = await reflectCoordinatorResult(
      workItem.hash,
      completionResult(workItem, [citationRequest("http://example.com/pending")]),
      {
        sourceOrigin: { source: "internal_worker" },
        readBackEnvelopeTimeoutMs: 5,
        now: () => 0,
        async readBackRecorder() {
          return new Promise<never>(() => {
            // Intentionally never settles: the envelope deadline must end the completion attempt.
          });
        },
      },
    );

    expect(reflection).toMatchObject({
      workItemStatus: "blocked",
      completionBlocked: true,
      completionBlocker: "read-back envelope deadline exceeded",
    });
    expect(WorkItemStore.get(workItem.hash)?.evidence).toEqual([]);
  });

  test("does not persist a recorder result produced after the shared deadline", async () => {
    const workItem = await createStartedWorkItem();
    let clock = 0;

    const reflection = await reflectCoordinatorResult(
      workItem.hash,
      completionResult(workItem, [citationRequest("http://example.com/late")]),
      {
        sourceOrigin: { source: "internal_worker" },
        readBackEnvelopeTimeoutMs: 10,
        now: () => clock,
        readBackRecorder(_hash, request) {
          if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
          clock = 20;
          return WorkItem.ReadBackCheck.parse({
            kind: "citation_match",
            target: request.target,
            quotedText: request.quotedText,
            matchedText: request.quotedText,
            passed: true,
            observedAt: clock,
            statusCode: 200,
          });
        },
      },
    );

    expect(reflection).toMatchObject({
      workItemStatus: "blocked",
      completionBlocked: true,
      completionBlocker: "read-back envelope deadline exceeded",
    });
    expect(WorkItemStore.get(workItem.hash)?.evidence).toEqual([]);
  });

  test("observes a recorder rejection produced after synchronous deadline exhaustion", async () => {
    const workItem = await createStartedWorkItem();
    let clock = 0;

    const reflection = await reflectCoordinatorResult(
      workItem.hash,
      completionResult(workItem, [citationRequest("http://example.com/late-rejection")]),
      {
        sourceOrigin: { source: "internal_worker" },
        readBackEnvelopeTimeoutMs: 10,
        now: () => clock,
        readBackRecorder() {
          clock = 20;
          return Promise.reject(new Error("late read-back rejection"));
        },
      },
    );

    expect(reflection).toMatchObject({
      workItemStatus: "blocked",
      completionBlocked: true,
      completionBlocker: "read-back envelope deadline exceeded",
    });
    expect(WorkItemStore.get(workItem.hash)?.evidence).toEqual([]);
  });

  test("rounds fractional envelope timeouts up to one millisecond", async () => {
    const workItem = await createStartedWorkItem();

    const reflection = await reflectCoordinatorResult(
      workItem.hash,
      completionResult(workItem, [citationRequest("http://example.com/source")]),
      {
        sourceOrigin: { source: "internal_worker" },
        readBackEnvelopeTimeoutMs: 0.25,
        now: () => 0,
        async readBackRecorder(_hash, request) {
          if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
          expect(request.timeoutMs).toBe(1);
          expect(request.maxBodyBytes).toBe(1_000_000);
          return WorkItem.ReadBackCheck.parse({
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
    expect(completed?.completionFacts.admissions).toHaveLength(1);
    expect(completed?.completionFacts.admissions[0]).toMatchObject({
      origin: "worker",
      decision: "admit",
    });
    expect(reflection).toMatchObject({
      workItemStatus: "completed",
      completionBlocked: false,
    });
  });

  test("rejects replay with changed criterion facts", async () => {
    const workItem = await createStartedWorkItem();
    const result = completionResult(workItem, [citationRequest("http://example.com/source")]);
    await reflectCoordinatorResult(workItem.hash, result, {
      sourceOrigin: { source: "internal_worker" },
      readBackRecorder: successfulReadBackRecorder,
    });
    const changedEnvelope = JSON.parse(result.output);
    changedEnvelope.criterionFacts[0].verification.kind = "numeric_recheck";

    const replay = await reflectCoordinatorResult(
      workItem.hash,
      { ...result, output: JSON.stringify(changedEnvelope) },
      {
        sourceOrigin: { source: "internal_worker" },
        readBackRecorder: successfulReadBackRecorder,
      },
    );

    expect(replay).toMatchObject({
      completionBlocked: true,
      completionBlocker: expect.stringContaining("completion envelope changed"),
    });
  });

  test("rejects replay with changed read-back request content", async () => {
    const workItem = await createStartedWorkItem();
    const result = completionResult(workItem, [citationRequest("http://example.com/source")]);
    await reflectCoordinatorResult(workItem.hash, result, {
      sourceOrigin: { source: "internal_worker" },
      readBackRecorder: successfulReadBackRecorder,
    });
    const changedEnvelope = JSON.parse(result.output);
    changedEnvelope.readBackRequests[0].request.target = "http://example.com/other-source";

    const replay = await reflectCoordinatorResult(
      workItem.hash,
      { ...result, output: JSON.stringify(changedEnvelope) },
      {
        sourceOrigin: { source: "internal_worker" },
        readBackRecorder: successfulReadBackRecorder,
      },
    );

    expect(replay).toMatchObject({
      completionBlocked: true,
      completionBlocker: expect.stringContaining("completion envelope changed"),
    });
  });

  test("redelivers an unchanged blocked completion without writes", async () => {
    const workItem = await createStartedWorkItem();
    const check = await successfulReadBackRecorder(
      workItem.hash,
      citationRequest("http://example.com/source").request,
    );
    const criterionId = workItem.completionFacts.criteria[0]?.id;
    if (!criterionId) throw new Error("missing read-back criterion");
    const evidence = await WorkItemStore.addReadBackEvidence(workItem.hash, check, {
      expectedAttempt: workItem.attempt,
      expectedBasisRef: workItem.completionContract.basisRef,
      criterionId,
    });
    const evidenceId = evidence?.evidence.at(-1)?.id;
    if (!evidenceId) throw new Error("missing completion evidence");
    const result = completionResult(workItem, []);
    const envelope = JSON.parse(result.output);
    envelope.criterionFacts[0].evidenceRefs = [{ source: "work_item", evidenceId }];
    envelope.completionReport.claims[0].evidenceIds = [evidenceId];
    const blockedResult = { ...result, output: JSON.stringify(envelope) };
    const policyEngine = PolicyEngine.create();
    policyEngine.register({
      kind: "point",
      name: "deny-completion",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": [] },
      priority: 100,
      fn: () =>
        PolicyDecision.deny({
          policyId: "test:deny-completion",
          reasonCodes: ["completion_denied"],
        }),
    });

    await reflectCoordinatorResultWithPolicy(workItem.hash, blockedResult, {
      completionWriter,
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine: policyEngine,
    });
    const blocked = WorkItemStore.get(workItem.hash);
    if (!blocked) throw new Error("missing blocked WorkItem");

    const replay = await reflectCoordinatorResultWithPolicy(workItem.hash, blockedResult, {
      completionWriter,
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine: policyEngine,
    });

    expect(replay).toMatchObject({ completionBlocked: true, workItemStatus: "blocked" });
    expect(WorkItemStore.get(workItem.hash)).toEqual(blocked);
    expect(WorkItemStore.get(workItem.hash)?.revision).toBe(blocked.revision);
    expect(WorkItemStore.get(workItem.hash)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(workItem.hash)?.blockers).toHaveLength(1);
  });
});
