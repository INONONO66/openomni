import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { PolicyEngine } from "@openomni/policy";
import { type Execution, PolicyDecision, WorkItem } from "@openomni/protocol";
import { Storage, WorkItemStore } from "@openomni/session";
import { VerifierRegistry } from "../../src/evidence/verifier-registry.js";
import {
  type ConnectorCompletionOptions,
  projectConnectorCompletion as projectConnectorCompletionProduction,
} from "../../src/dispatch/handlers/connector-completion-projector.js";
import { Stakes } from "../../src/ledger/index.js";
import {
  reflectCoordinatorResult as reflectCoordinatorResultProduction,
  type WorkerCompletionOptions,
  workerCompletionRequestId,
  workerCompletionReservationRoot,
  workerCompletionRequestRoot,
} from "../../src/dispatch/handlers/worker-completion.js";
import {
  createCompletionAdmissionService,
  createDurableCompletionResultAuthorityPort,
  reserveCompletionRequest,
  type CompletionAdmissionService,
  type CompletionStakesResolver,
} from "../../src/work-item/completion-admission.js";

const NOW = 1_000;
const COMPLETION_POLICY_ENGINE = PolicyEngine.create();
let completionWriter: Storage.WorkItemCompletionWriter;
const WORKER_RUN_ID = "run:completion-admission";
const WORKER_SESSION_ID = "session:completion-admission";

type CompletionServiceOverrides = Readonly<{
  policyEngine?: ReturnType<typeof PolicyEngine.create>;
  ownerId?: string;
  stakesResolver?: CompletionStakesResolver;
  now?: () => number;
}>;

function completionService(overrides: CompletionServiceOverrides = {}): CompletionAdmissionService {
  return createCompletionAdmissionService({
    completionWriter,
    policyEngine: overrides.policyEngine ?? COMPLETION_POLICY_ENGINE,
    now: overrides.now ?? Date.now,
    ...(overrides.ownerId === undefined ? {} : { ownerId: overrides.ownerId }),
    ...(overrides.stakesResolver === undefined ? {} : { stakesResolver: overrides.stakesResolver }),
  });
}

/** One completion-point policy engine that always denies with the given reasons. */
function denyingPolicyEngine(
  reasonCodes: readonly string[],
  policyId = "deny-completion",
): ReturnType<typeof PolicyEngine.create> {
  const engine = PolicyEngine.create();
  engine.register({
    kind: "point",
    name: policyId,
    pointIds: ["work.complete.pre"],
    effectCapabilities: { "work.complete.pre": [] },
    priority: 0,
    fn: () => PolicyDecision.deny({ policyId, reasonCodes: [...reasonCodes] }),
  });
  return engine;
}

type ReflectOptions = Omit<WorkerCompletionOptions, "completionService" | "verifierRegistry"> &
  Readonly<{
    completionService?: CompletionAdmissionService;
    completionPolicyEngine?: ReturnType<typeof PolicyEngine.create>;
    stakesResolver?: CompletionStakesResolver;
    verifierRegistry?: WorkerCompletionOptions["verifierRegistry"];
  }>;

function completionServiceFor(
  options: Pick<
    ReflectOptions,
    "completionService" | "completionPolicyEngine" | "stakesResolver" | "now"
  >,
): CompletionAdmissionService {
  return (
    options.completionService ??
    completionService({
      ...(options.completionPolicyEngine === undefined
        ? {}
        : { policyEngine: options.completionPolicyEngine }),
      ...(options.stakesResolver === undefined ? {} : { stakesResolver: options.stakesResolver }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  );
}

function codeUnitCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(codeUnitCanonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${codeUnitCanonicalJson(entryValue)}`)
    .join(",")}}`;
}

function reflectCoordinatorResult(
  workItemHash: string,
  result: Execution.Result,
  options: ReflectOptions,
) {
  const {
    completionPolicyEngine: _policyEngine,
    stakesResolver: _stakesResolver,
    completionService: _completionService,
    ...rest
  } = options;
  return reflectCoordinatorResultProduction(
    workItemHash,
    result,
    {
      ...rest,
      completionService: completionServiceFor(options),
      verifierRegistry: options.verifierRegistry ?? VerifierRegistry.create(),
    },
    "trace-test",
  );
}

function projectConnectorCompletion(
  workItemHash: string,
  result: Execution.Result,
  options: Omit<ConnectorCompletionOptions, "completionService" | "verifierRegistry"> &
    Pick<
      ReflectOptions,
      "completionService" | "completionPolicyEngine" | "stakesResolver" | "verifierRegistry"
    >,
) {
  const {
    completionPolicyEngine: _policyEngine,
    stakesResolver: _stakesResolver,
    completionService: _completionService,
    ...rest
  } = options;
  return projectConnectorCompletionProduction(
    workItemHash,
    result,
    {
      ...rest,
      completionService: completionServiceFor(options),
      verifierRegistry: options.verifierRegistry ?? VerifierRegistry.create(),
    },
    "trace-test",
  );
}

beforeEach(() => {
  Storage.reset();
  completionWriter = Storage.initialize({ dbPath: ":memory:" });
});

async function startedItem(
  executorKind?: WorkItem.ExecutorKind,
  criterionStatement = "recorded numeric operands satisfy eq",
): Promise<WorkItem.Info> {
  const created = await WorkItemStore.create(
    {
      name: `Completion ${executorKind}`,
      sourceMessageId: `dispatch:${executorKind}`,
      sourceChannel: "dispatch",
      intent: "worker.spawn",
      goal: "prove completion admission convergence",
      executorKind,
      workSessionId: WORKER_SESSION_ID,
      workerRunId: WORKER_RUN_ID,
      acceptanceCriteria: [criterionStatement],
    },
    "trace-test",
  );
  const started = await WorkItemStore.start(created.hash, "trace-test");
  if (!started) throw new Error("missing started work item");
  return started;
}

async function evidenceBackedEnvelope(
  hash: string,
  verification: Readonly<{
    kind: string;
    recordedInputs: Readonly<Record<string, unknown>>;
  }> = {
    kind: "numeric_recheck",
    recordedInputs: { operator: "eq", left: 1, right: 1 },
  },
): Promise<string> {
  const current = WorkItemStore.get(hash);
  const criterion = current?.completionFacts.criteria[0];
  if (!current || !criterion) throw new Error("missing completion fixture");
  const withEvidence = await WorkItemStore.addEvidence(
    hash,
    {
      kind: "test_result",
      description: "kernel-recorded verifier input",
      passed: true,
      detail: JSON.stringify({
        type: "verifier_recorded_inputs",
        version: 1,
        workItemHash: current.hash,
        basisRef: current.completionContract.basisRef,
        criterionId: criterion.id,
        verifierKind: verification.kind,
        recordedInputs: verification.recordedInputs,
      }),
    },
    "trace-test",
  );
  const evidenceId = withEvidence?.evidence.at(-1)?.id;
  if (!evidenceId) throw new Error("missing completion fixture");
  return JSON.stringify({
    completionReport: {
      summary: "Completed through the admission boundary.",
      claims: [{ statement: criterion.statement, evidenceIds: [evidenceId] }],
    },
    criterionFacts: [
      {
        criterionIndex: 0,
        evidenceRefs: [{ source: "work_item", evidenceId }],
        verification: { kind: verification.kind },
      },
    ],
  });
}

type ResultIdentity = Readonly<{ runId: string; sessionId: string }>;

function succeeded(
  output: string,
  identity: ResultIdentity = { runId: WORKER_RUN_ID, sessionId: WORKER_SESSION_ID },
): Execution.Result {
  return {
    ...identity,
    status: "succeeded",
    output,
  };
}

async function bindRetryAttempt(
  hash: string,
  attempt: number,
  executorKind: WorkItem.ExecutorKind = "internal_chat_agent",
): Promise<ResultIdentity> {
  const identity = {
    runId: `${WORKER_RUN_ID}:attempt:${attempt}`,
    sessionId: `${WORKER_SESSION_ID}:attempt:${attempt}`,
  };
  const updated = await WorkItemStore.assignExecution(
    hash,
    {
      workerRunId: identity.runId,
      workSessionId: identity.sessionId,
      executorKind,
    },
    "trace-test",
  );
  if (!updated) throw new Error("failed to bind retry Worker identity");
  return identity;
}

describe("worker completion admission convergence", () => {
  test("uses code-unit ordering for Unicode completion envelope identity", async () => {
    const item = await startedItem();
    const rawEnvelope = JSON.parse(await evidenceBackedEnvelope(item.hash)) as Record<
      string,
      unknown
    >;
    rawEnvelope.deliverable = { ä: "umlaut", z: "zed" };
    const normalizedEnvelope = {
      ...rawEnvelope,
      completionReport: {
        ...(rawEnvelope.completionReport as Record<string, unknown>),
        caveats: [],
        followUps: [],
      },
      readBackRequests: [],
    };
    const result = succeeded(JSON.stringify(rawEnvelope));

    await reflectCoordinatorResult(item.hash, result, {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine: COMPLETION_POLICY_ENGINE,
      now: () => NOW,
    });
    const digest = createHash("sha256")
      .update(codeUnitCanonicalJson(normalizedEnvelope))
      .digest("hex");

    expect(
      WorkItemStore.get(item.hash)?.completionFacts.requestReservations.at(-1)?.envelopeDigest,
    ).toBe(digest);
    expect(WorkItemStore.get(item.hash)?.completionTerminalReceipt?.requestId).toBe(
      workerCompletionRequestRoot(item, result),
    );
  });

  test("rejects non-finite completion envelope numbers before reservation", async () => {
    const item = await startedItem();
    const envelope = await evidenceBackedEnvelope(item.hash);
    const nonFiniteEnvelope = `{"deliverable":1e400,${envelope.slice(1)}`;

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(nonFiniteEnvelope), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine: COMPLETION_POLICY_ENGINE,
      now: () => NOW,
    });

    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("expected bounded plain JSON data");
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toEqual([]);
    expect(WorkItemStore.get(item.hash)?.completionFacts.requestReservations).toEqual([]);
  });

  test("admits one real internal worker result and links its terminal receipt", async () => {
    const item = await startedItem("internal_chat_agent");

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(await evidenceBackedEnvelope(item.hash)),
      {
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW,
      },
    );

    const stored = WorkItemStore.get(item.hash);
    const admission = stored?.completionFacts.admissions[0];
    expect(reflection).toMatchObject({ workItemStatus: "completed", completionBlocked: false });
    expect(stored?.completionFacts.results[0]).toMatchObject({
      value: "verified",
      verifierRef: "builtin.numeric-v1",
      checkedPredicate: "recorded numeric operands satisfy eq",
    });
    expect(stored?.completionFacts.claims[0]?.statement).toBe(
      stored?.completionFacts.criteria[0]?.statement,
    );
    expect(stored?.completionFacts.observations[0]).toMatchObject({
      artifactRefs: [stored?.evidence[0]?.id],
      provenanceRef: stored?.evidence[0]?.id,
    });
    expect(admission).toMatchObject({
      origin: "worker",
      decision: "admit",
      policyRef: "agent.policy.composed",
    });
    expect(stored?.completionTerminalReceipt).toMatchObject({
      admissionId: admission?.id,
      requestId: admission?.requestId,
      contractRevision: stored?.completionContract.revision,
      basisRef: stored?.completionContract.basisRef,
    });
  });

  test("normalizes the reservation lease from the bounded read-back timeout", async () => {
    const item = await startedItem("internal_chat_agent");
    const completionPolicyEngine = denyingPolicyEngine(["hold"], "hold-normalized-lease");

    await reflectCoordinatorResult(item.hash, succeeded(await evidenceBackedEnvelope(item.hash)), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine,
      readBackEnvelopeTimeoutMs: 12.1,
      now: () => 100,
    });

    expect(
      WorkItemStore.get(item.hash)?.completionFacts.requestReservations[0]?.leaseExpiresAt,
    ).toBe(5_113);
  });

  test("refuses terminal compare-and-set after its reservation expires", async () => {
    const item = await startedItem("internal_chat_agent");
    const adapter = Storage.get().workItem;
    if (!adapter) throw new Error("missing WorkItem adapter");
    const compareAndSet = adapter.compareAndSet.bind(adapter);
    let clock = 0;
    adapter.compareAndSet = (hash, expectedHead, candidate) => {
      if (
        candidate.completionTerminalReceipt === undefined &&
        candidate.completionFacts.admissions.length === 1
      ) {
        clock = 5_001;
      }
      return compareAndSet(hash, expectedHead, candidate);
    };

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(await evidenceBackedEnvelope(item.hash)),
      {
        sourceOrigin: { source: "internal_worker" },
        readBackEnvelopeTimeoutMs: 1,
        now: () => clock,
      },
    );

    expect(reflection.completionBlocker).toContain("completion reservation lease lost");
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(item.hash)?.completionTerminalReceipt).toBeUndefined();
  });

  test("replays a completed Worker result without renewing an expired reservation", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = await evidenceBackedEnvelope(item.hash);
    await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      readBackEnvelopeTimeoutMs: 1,
      now: () => 0,
    });
    const beforeReplay = WorkItemStore.get(item.hash)?.completionFacts.requestReservations.at(-1);

    const replay = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      readBackEnvelopeTimeoutMs: 1,
      now: () => 5_001,
    });

    expect(replay).toMatchObject({ completionBlocked: false, workItemStatus: "completed" });
    expect(WorkItemStore.get(item.hash)?.completionFacts.requestReservations.at(-1)).toEqual(
      beforeReplay,
    );
  });

  test("replays an admitted byte-identical envelope without re-running verification", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = await evidenceBackedEnvelope(item.hash);
    const first = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });
    expect(first).toMatchObject({ completionBlocked: false, workItemStatus: "completed" });

    const registrySpy = spyOn(VerifierRegistry, "create").mockImplementation(
      () =>
        ({
          verify() {
            throw new Error("verifier must not re-run on byte-identical replay");
          },
        }) as unknown as ReturnType<typeof VerifierRegistry.create>,
    );
    const throwingService: CompletionAdmissionService = {
      ...completionService({ now: () => NOW + 1 }),
      requestCompletion() {
        throw new Error("admission service must not re-admit a byte-identical replay");
      },
    };
    try {
      const replay = await reflectCoordinatorResult(item.hash, succeeded(output), {
        completionService: throwingService,
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW + 1,
      });

      expect(replay).toMatchObject({ completionBlocked: false, workItemStatus: "completed" });
    } finally {
      registrySpy.mockRestore();
    }

    const mutatedEnvelope = JSON.parse(output) as { completionReport: { summary: string } };
    mutatedEnvelope.completionReport.summary = "Mutated after terminal admission.";
    const conflict = await reflectCoordinatorResult(
      item.hash,
      succeeded(JSON.stringify(mutatedEnvelope)),
      {
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW + 2,
      },
    );

    expect(conflict).toMatchObject({
      completionBlocked: true,
      completionBlocker: expect.stringContaining("completion envelope changed"),
    });
  });

  test("persists a qualified completion identity in the durable request", async () => {
    const item = await startedItem("internal_chat_agent");
    const sourceIdentity = {
      source: "internal",
      identity: { kind: "worker", id: WORKER_RUN_ID },
    } as const;

    await reflectCoordinatorResult(item.hash, succeeded(await evidenceBackedEnvelope(item.hash)), {
      sourceOrigin: sourceIdentity,
      now: () => NOW,
    });

    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions[0]?.sourceIdentity).toEqual(
      sourceIdentity,
    );
  });

  test("snapshots mutable source identity before reservation", async () => {
    const item = await startedItem("internal_chat_agent");
    const result = succeeded(await evidenceBackedEnvelope(item.hash));
    const sourceOrigin = {
      source: "internal" as const,
      identity: { kind: "worker" as const, id: "worker:source-a" },
    };
    const expectedRoot = workerCompletionReservationRoot(
      item,
      result,
      structuredClone(sourceOrigin),
    );

    const pending = reflectCoordinatorResult(item.hash, result, {
      sourceOrigin,
      now: () => NOW,
    });
    sourceOrigin.identity.id = "worker:source-b";
    const reflection = await pending;
    const stored = WorkItemStore.get(item.hash);

    expect(reflection.completionBlocked).toBe(false);
    expect(stored?.completionFacts.requestReservations.at(-1)?.requestRoot).toBe(expectedRoot);
    expect(stored?.completionFacts.admissions[0]?.sourceIdentity).toEqual({
      source: "internal",
      identity: { kind: "worker", id: "worker:source-a" },
    });
  });

  test("rejects completed replay from a different qualified source identity", async () => {
    const item = await startedItem("internal_chat_agent");
    const result = succeeded(await evidenceBackedEnvelope(item.hash));
    const sourceA = {
      source: "internal",
      identity: { kind: "worker", id: "worker:source-a" },
    } as const;
    const sourceB = {
      source: "internal",
      identity: { kind: "worker", id: "worker:source-b" },
    } as const;

    const first = await reflectCoordinatorResult(item.hash, result, {
      sourceOrigin: sourceA,
      now: () => NOW,
    });
    const replay = await reflectCoordinatorResult(item.hash, result, {
      sourceOrigin: sourceB,
      now: () => NOW + 1,
    });

    expect(first.completionBlocked).toBe(false);
    expect(replay.completionBlocked).toBe(true);
    expect(replay.completionBlocker).toContain("conflicts with durable source identity");
    expect(
      WorkItemStore.get(item.hash)?.completionFacts.admissions.map(
        ({ sourceIdentity }) => sourceIdentity,
      ),
    ).toEqual([sourceA]);
  });

  test("rejects recovery replay of an internal Worker admission", async () => {
    const item = await startedItem("internal_chat_agent");
    const result = succeeded(await evidenceBackedEnvelope(item.hash));

    const first = await reflectCoordinatorResult(item.hash, result, {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });
    const recovery = await reflectCoordinatorResult(item.hash, result, {
      sourceOrigin: { source: "recovery" },
      now: () => NOW + 1,
    });

    expect(first.completionBlocked).toBe(false);
    expect(recovery.completionBlocked).toBe(true);
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions[0]?.sourceIdentity).toEqual({
      source: "internal_worker",
      identity: {
        kind: "worker",
        id: `${WORKER_SESSION_ID}:${WORKER_RUN_ID}`,
      },
    });
  });

  test.each([
    "replay",
    "recovery",
  ] as const)("admits a fresh %s Worker completion source", async (source) => {
    const item = await startedItem("internal_chat_agent");
    const result = succeeded(await evidenceBackedEnvelope(item.hash));

    const reflection = await reflectCoordinatorResult(item.hash, result, {
      sourceOrigin: { source },
      now: () => NOW,
    });

    expect(reflection.completionBlocked).toBe(false);
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions[0]?.sourceIdentity).toEqual({
      source,
      identity: {
        kind: "worker",
        id: `${WORKER_SESSION_ID}:${WORKER_RUN_ID}`,
      },
    });
  });

  test("binds pre-admission reservations to the qualified source identity", async () => {
    const item = await startedItem("internal_chat_agent");
    const result = succeeded(await evidenceBackedEnvelope(item.hash));
    const sourceA = {
      source: "internal",
      identity: { kind: "worker", id: "worker:source-a" },
    } as const;
    const sourceB = {
      source: "internal",
      identity: { kind: "worker", id: "worker:source-b" },
    } as const;
    const envelopeDigest = "envelope-digest:source-bound";
    const requestId = workerCompletionRequestId(item, result);
    const rootA = workerCompletionReservationRoot(item, result, sourceA);
    const rootB = workerCompletionReservationRoot(item, result, sourceB);
    const replayRoot = workerCompletionReservationRoot(item, result, { source: "replay" });
    const recoveryRoot = workerCompletionReservationRoot(item, result, { source: "recovery" });

    expect(rootA).not.toBe(rootB);
    expect(replayRoot).not.toBe(recoveryRoot);
    reserveCompletionRequest({
      completionWriter,
      workItemHash: item.hash,
      requestId,
      requestRoot: rootA,
      envelopeDigest,
      ownerId: "process:source-a",
      leaseDurationMs: 1,
      now: NOW,
    });

    expect(() =>
      reserveCompletionRequest({
        completionWriter,
        workItemHash: item.hash,
        requestId,
        requestRoot: rootB,
        envelopeDigest: "envelope-digest:source-b",
        ownerId: "process:source-b",
        leaseDurationMs: 1,
        now: NOW + 2,
      }),
    ).toThrow("completion request conflicts with durable facts");
  });

  test.each([
    ["run", { runId: "run:other" }],
    ["session", { sessionId: "session:other" }],
  ] as const)("rejects a mismatched Worker %s identity before admission", async (_name, mismatch) => {
    const item = await startedItem("internal_chat_agent");
    const result = { ...succeeded(await evidenceBackedEnvelope(item.hash)), ...mismatch };

    const reflection = await reflectCoordinatorResult(item.hash, result, {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });

    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("identity mismatch");
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toEqual([]);
  });

  test("rejects a terminal WorkItem before reserving its completion request", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = await evidenceBackedEnvelope(item.hash);
    await WorkItemStore.fail(item.hash, "trace-test", "worker failed first");
    const before = WorkItemStore.get(item.hash);
    if (!before) throw new Error("missing terminal completion fixture");

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });

    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("Cannot complete a failed WorkItem");
    expect(WorkItemStore.get(item.hash)).toEqual(before);
  });

  test("reuses one immutable Worker admission before repeating read-back", async () => {
    const predicate = "archived source contains the recorded quote exactly";
    const item = await startedItem("internal_chat_agent", predicate);
    const requestRoot = workerCompletionRequestRoot(item, succeeded(""));
    const existingReadBackEvidenceId = `evidence:read-back:${createHash("sha256")
      .update(`${requestRoot}:0`)
      .digest("hex")}`;
    const output = JSON.stringify({
      completionReport: {
        summary: "Read-back replay remains bound to one admission.",
        claims: [{ statement: predicate, evidenceIds: [existingReadBackEvidenceId] }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
      ],
      readBackRequests: [
        {
          claimIndex: 0,
          criterionIndex: 0,
          request: {
            kind: "citation_match",
            target: "http://example.com/read-back",
            quotedText: "stable replay marker",
          },
        },
      ],
    });
    let readBackCalls = 0;
    const options: ReflectOptions = {
      completionService: completionService({ ownerId: "process:one", now: () => NOW }),
      sourceOrigin: { source: "internal_worker" } as const,
      now: () => NOW,
      async readBackRecorder(_hash, request) {
        readBackCalls += 1;
        if (readBackCalls > 1) throw new Error("duplicate delivery repeated read-back");
        if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
        return WorkItem.ReadBackCheck.parse({
          kind: "citation_match",
          target: request.target,
          quotedText: request.quotedText,
          matchedText: request.quotedText,
          passed: true,
          observedAt: NOW,
          statusCode: 200,
        });
      },
    };

    const first = await reflectCoordinatorResult(item.hash, succeeded(output), options);
    const replay = await reflectCoordinatorResult(item.hash, succeeded(output), options);
    const changedEnvelope = JSON.parse(output) as {
      completionReport: { summary: string };
    };
    changedEnvelope.completionReport.summary = "A changed report must not reuse the old admission.";
    const conflict = await reflectCoordinatorResult(
      item.hash,
      succeeded(JSON.stringify(changedEnvelope)),
      options,
    );

    const stored = WorkItemStore.get(item.hash);
    expect(first.completionBlocker).toBeUndefined();
    expect(first.completionBlocked).toBe(false);
    expect(replay.completionBlocked).toBe(false);
    expect(conflict.completionBlocked).toBe(true);
    expect(conflict.completionBlocker).toContain("completion envelope changed");
    expect(readBackCalls).toBe(1);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored?.completionTerminalReceipt?.requestId).toBe(
      stored?.completionFacts.admissions[0]?.requestId,
    );
    expect(stored?.completionTerminalReceipt?.requestId).toStartWith(
      `completion-request:${item.hash}:${WORKER_RUN_ID}:${WORKER_SESSION_ID}:`,
    );
  });

  test("reuses durable read-back evidence after failure before admission", async () => {
    const predicate = "archived source contains the recorded quote exactly";
    const item = await startedItem("internal_chat_agent", predicate);
    const output = JSON.stringify({
      completionReport: {
        summary: "Read-back survives pre-admission authority failure.",
        claims: [{ statement: predicate }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
      ],
      readBackRequests: [
        {
          claimIndex: 0,
          criterionIndex: 0,
          request: {
            kind: "citation_match",
            target: "http://example.com/read-back",
            quotedText: "durable pre-admission marker",
          },
        },
      ],
    });
    const result = succeeded(output);
    const requestRoot = workerCompletionRequestRoot(item, result);
    const evidenceId = `evidence:read-back:${createHash("sha256")
      .update(`${requestRoot}:0`)
      .digest("hex")}`;
    await WorkItemStore.addReadBackEvidence(
      item.hash,
      WorkItem.ReadBackCheck.parse({
        kind: "citation_match",
        target: "http://example.com/read-back",
        quotedText: "durable pre-admission marker",
        matchedText: "durable pre-admission marker",
        passed: true,
        observedAt: NOW,
        statusCode: 200,
      }),
      "trace-test",
      {
        expectedAttempt: item.attempt,
        expectedBasisRef: item.completionContract.basisRef,
        criterionId: item.completionFacts.criteria[0]?.id ?? "criterion:missing",
        evidenceId,
      },
    );
    const afterFailure = WorkItemStore.get(item.hash);
    let readBackCalls = 0;
    const options = {
      completionService: completionService({ ownerId: "process:one", now: () => NOW }),
      sourceOrigin: { source: "internal_worker" } as const,
      completionPolicyEngine: COMPLETION_POLICY_ENGINE,
      now: () => NOW,
      readBackRecorder() {
        readBackCalls += 1;
        throw new Error("durable read-back was executed again");
      },
    };

    const recovered = await reflectCoordinatorResult(item.hash, result, options);
    const stored = WorkItemStore.get(item.hash);

    expect(afterFailure?.completionFacts.admissions).toEqual([]);
    expect(afterFailure?.blockers).toEqual([]);
    expect(afterFailure?.evidence).toHaveLength(1);
    expect(recovered.completionBlocked).toBe(false);
    expect(readBackCalls).toBe(0);
    expect(stored?.evidence).toHaveLength(1);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored?.completionTerminalReceipt).toBeDefined();
  });

  test("persists deterministic verifier mismatch after checkpoint without repeating read-back", async () => {
    const predicate = "archived source contains the recorded quote exactly";
    const item = await startedItem("internal_chat_agent", predicate);
    const output = JSON.stringify({
      completionReport: {
        summary: "Verifier kind does not match the durable read-back.",
        claims: [{ statement: predicate }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "numeric_recheck" },
        },
      ],
      readBackRequests: [
        {
          claimIndex: 0,
          criterionIndex: 0,
          request: {
            kind: "citation_match",
            target: "http://example.com/read-back-mismatch",
            quotedText: "deterministic mismatch marker",
          },
        },
      ],
    });
    let readBackCalls = 0;
    const options: ReflectOptions = {
      completionService: completionService({ ownerId: "process:one", now: () => NOW }),
      sourceOrigin: { source: "internal_worker" } as const,
      completionPolicyEngine: COMPLETION_POLICY_ENGINE,
      now: () => NOW,
      async readBackRecorder(_hash, request) {
        readBackCalls += 1;
        if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
        return WorkItem.ReadBackCheck.parse({
          kind: "citation_match",
          target: request.target,
          quotedText: request.quotedText,
          matchedText: request.quotedText,
          passed: true,
          observedAt: NOW,
          statusCode: 200,
        });
      },
    };

    const first = await reflectCoordinatorResult(item.hash, succeeded(output), options);
    const second = await reflectCoordinatorResult(item.hash, succeeded(output), options);
    const stored = WorkItemStore.get(item.hash);

    expect(first.completionBlocked).toBe(true);
    expect(first.completionBlocker).toContain("verifier evidence does not match read-back kind");
    expect(second.completionBlocker).toBe(first.completionBlocker);
    expect(readBackCalls).toBe(1);
    expect(stored?.evidence).toHaveLength(1);
    expect(stored?.blockers).toHaveLength(1);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("blocked");
    expect(stored?.completionFacts.admissions).toEqual([]);
  });

  test("reserves one completion request before concurrent read-back", async () => {
    const predicate = "archived source contains the recorded quote exactly";
    const item = await startedItem("internal_chat_agent", predicate);
    const output = JSON.stringify({
      completionReport: {
        summary: "Concurrent redelivery shares one read-back.",
        claims: [{ statement: predicate }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
      ],
      readBackRequests: [
        {
          claimIndex: 0,
          criterionIndex: 0,
          request: {
            kind: "citation_match",
            target: "http://example.com/concurrent-read-back",
            quotedText: "concurrent marker",
          },
        },
      ],
    });
    const readBackStarted = Promise.withResolvers<void>();
    const releaseReadBack = Promise.withResolvers<void>();
    let readBackCalls = 0;
    const options: ReflectOptions = {
      completionService: completionService({ ownerId: "process:one", now: () => NOW }),
      sourceOrigin: { source: "internal_worker" } as const,
      now: () => NOW,
      async readBackRecorder(_hash, request) {
        readBackCalls += 1;
        if (readBackCalls > 1) throw new Error("concurrent delivery repeated read-back");
        readBackStarted.resolve();
        await releaseReadBack.promise;
        if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
        return WorkItem.ReadBackCheck.parse({
          kind: "citation_match",
          target: request.target,
          quotedText: request.quotedText,
          matchedText: request.quotedText,
          passed: true,
          observedAt: NOW,
          statusCode: 200,
        });
      },
    };

    const firstPromise = reflectCoordinatorResult(item.hash, succeeded(output), options);
    await readBackStarted.promise;
    const second = await reflectCoordinatorResult(item.hash, succeeded(output), {
      ...options,
      completionService: completionService({ ownerId: "process:two", now: () => NOW }),
    });
    try {
      expect(second.completionBlocked).toBe(true);
      expect(second.completionBlocker).toContain("already in progress");
      expect(readBackCalls).toBe(1);
      expect(WorkItemStore.get(item.hash)?.blockers).toEqual([]);
    } finally {
      releaseReadBack.resolve();
    }
    const first = await firstPromise;
    const replay = await reflectCoordinatorResult(item.hash, succeeded(output), options);
    const stored = WorkItemStore.get(item.hash);

    expect(stored?.completionFacts.verificationErrors).toEqual([]);
    expect(first.completionBlocker).toBeUndefined();
    expect(first.completionBlocked).toBe(false);
    expect(replay.completionBlocked).toBe(false);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored?.completionTerminalReceipt?.requestId).toBe(
      stored?.completionFacts.admissions[0]?.requestId,
    );
  });

  test("keeps takeover ownership active when the expired predecessor exits", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = await evidenceBackedEnvelope(item.hash);
    const aEntered = Promise.withResolvers<void>();
    const releaseA = Promise.withResolvers<void>();
    const bEntered = Promise.withResolvers<void>();
    const releaseB = Promise.withResolvers<void>();
    let policyBCalls = 0;
    const policy = (
      name: string,
      entered: ReturnType<typeof Promise.withResolvers<void>>,
      release: ReturnType<typeof Promise.withResolvers<void>>,
    ) => {
      const engine = PolicyEngine.create();
      engine.register({
        kind: "point",
        name,
        pointIds: ["work.complete.pre"],
        effectCapabilities: { "work.complete.pre": [] },
        priority: 0,
        async fn() {
          if (name === "takeover-owner-b") policyBCalls += 1;
          entered.resolve();
          await release.promise;
          return PolicyDecision.allow({ policyId: name, reasonCodes: [] });
        },
      });
      return engine;
    };
    const policyA = policy("takeover-owner-a", aEntered, releaseA);
    const policyB = policy("takeover-owner-b", bEntered, releaseB);
    let clock = 0;
    const base = {
      sourceOrigin: { source: "internal_worker" } as const,
      now: () => clock,
    };
    // One process owner across contenders, matching production's single service.
    const contenderService = (policyEngine: ReturnType<typeof PolicyEngine.create>) =>
      completionService({ policyEngine, ownerId: "process:takeover", now: () => clock });

    const attemptA = reflectCoordinatorResult(item.hash, succeeded(output), {
      ...base,
      completionService: contenderService(policyA),
    });
    await aEntered.promise;
    clock = 20_000;
    // In-flight tracking is service-instance state (#549): the takeover owner
    // and the later contender go through the same service, as in production.
    const serviceB = contenderService(policyB);
    const attemptB = reflectCoordinatorResult(item.hash, succeeded(output), {
      ...base,
      completionService: serviceB,
    });
    await bEntered.promise;
    releaseA.resolve();
    const expiredA = await attemptA;
    const contenderC = await reflectCoordinatorResult(item.hash, succeeded(output), {
      ...base,
      completionService: serviceB,
    });
    try {
      expect(expiredA.completionBlocker).toContain("completion reservation lease lost");
      expect(contenderC.completionBlocker).toContain("already in progress");
      expect(policyBCalls).toBe(1);
    } finally {
      releaseB.resolve();
    }
    const completedB = await attemptB;
    const stored = WorkItemStore.get(item.hash);

    expect(completedB.completionBlocked).toBe(false);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored?.completionTerminalReceipt).toBeDefined();
  });

  test("refuses admission when the reservation expires during authority evaluation", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = await evidenceBackedEnvelope(item.hash);
    let clock = 0;
    const completionPolicyEngine = PolicyEngine.create();
    completionPolicyEngine.register({
      kind: "point",
      name: "expire-completion-lease",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": [] },
      priority: 0,
      fn: () => {
        clock = 20_000;
        return PolicyDecision.allow({
          policyId: "expire-completion-lease",
          reasonCodes: [],
        });
      },
    });

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine,
      now: () => clock,
    });
    const stored = WorkItemStore.get(item.hash);

    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("completion reservation lease lost");
    expect(stored?.completionFacts.admissions).toEqual([]);
    expect(stored?.completionTerminalReceipt).toBeUndefined();
    expect(stored?.blockers).toEqual([]);
  });

  test("rejects durable verifier evidence rewrites before stale-head replay", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = await evidenceBackedEnvelope(item.hash);
    const completionPolicyEngine = denyingPolicyEngine(
      ["hold_for_replay"],
      "block-before-durable-replay",
    );
    const options = {
      sourceOrigin: { source: "internal_worker" } as const,
      completionPolicyEngine,
      now: () => NOW,
    };

    await reflectCoordinatorResult(item.hash, succeeded(output), options);
    const blocked = WorkItemStore.get(item.hash);
    const evidence = blocked?.evidence[0];
    if (!blocked || evidence?.detail === undefined) {
      throw new Error("missing blocked durable verifier evidence");
    }
    const detail = JSON.parse(evidence.detail) as {
      recordedInputs: Record<string, unknown>;
    };
    const tampered = WorkItem.Info.parse({
      ...blocked,
      revision: blocked.revision + 1,
      evidence: blocked.evidence.map((entry) =>
        entry.id === evidence.id
          ? {
              ...entry,
              detail: JSON.stringify({
                ...detail,
                recordedInputs: { operator: "eq", left: 1, right: 2 },
              }),
            }
          : entry,
      ),
      timestamps: { ...blocked.timestamps, updated: NOW + 1 },
    });
    expect(() => completionWriter(blocked.hash, blocked.revision, tampered)).toThrow(
      "evidence are append-only",
    );
    expect(WorkItemStore.get(item.hash)).toEqual(blocked);
  });

  test("rejects unrelated artifacts appended to a verifier observation", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = await evidenceBackedEnvelope(item.hash);
    const completionPolicyEngine = denyingPolicyEngine(
      ["inspect_artifact_binding"],
      "hold-artifact-binding",
    );
    await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine,
      now: () => NOW,
    });
    await WorkItemStore.addEvidence(
      item.hash,
      {
        kind: "verification",
        description: "unrelated passing artifact",
        passed: true,
      },
      "trace-test",
    );
    const stored = WorkItemStore.get(item.hash);
    const criterion = stored?.completionFacts.criteria[0];
    const result = stored?.completionFacts.results[0];
    const observation = stored?.completionFacts.observations[0];
    const unrelatedEvidenceId = stored?.evidence.at(-1)?.id;
    if (!stored || !criterion || !result || !observation || !unrelatedEvidenceId) {
      throw new Error("missing artifact-binding fixture");
    }

    const port = createDurableCompletionResultAuthorityPort();
    const appendedArtifact = await port.validate({
      workItemHash: stored.hash,
      requestId: "request:artifact-binding",
      contractRevision: stored.completionContract.revision,
      basisRef: stored.completionContract.basisRef,
      criterion,
      result: { ...result, observationIds: [observation.id] },
      observations: [
        {
          ...observation,
          artifactRefs: [...observation.artifactRefs, unrelatedEvidenceId],
        },
      ],
    });
    const appendedObservation = await port.validate({
      workItemHash: stored.hash,
      requestId: "request:observation-binding",
      contractRevision: stored.completionContract.revision,
      basisRef: stored.completionContract.basisRef,
      criterion,
      result: {
        ...result,
        observationIds: [observation.id, "observation:unrelated"],
      },
      observations: [
        observation,
        {
          ...observation,
          id: "observation:unrelated",
          artifactRefs: [unrelatedEvidenceId],
          provenanceRef: unrelatedEvidenceId,
        },
      ],
    });
    const unrelatedCriterion = await port.validate({
      workItemHash: stored.hash,
      requestId: "request:criterion-binding",
      contractRevision: stored.completionContract.revision,
      basisRef: stored.completionContract.basisRef,
      criterion: { ...criterion, statement: "production deployed" },
      result,
      observations: [observation],
    });

    expect(appendedArtifact).toEqual({ ok: false });
    expect(appendedObservation).toEqual({ ok: false });
    expect(unrelatedCriterion).toEqual({ ok: false });
  });

  test("rejects actor reuse of read-back evidence across duplicate criteria", async () => {
    const statement = "archived source contains the recorded quote exactly";
    const created = await WorkItemStore.create(
      {
        name: "Duplicate criterion binding",
        sourceMessageId: "dispatch:duplicate-criterion-binding",
        sourceChannel: "dispatch",
        intent: "worker.spawn",
        goal: "keep read-back evidence criterion-local",
        executorKind: "internal_chat_agent",
        workSessionId: WORKER_SESSION_ID,
        workerRunId: WORKER_RUN_ID,
        acceptanceCriteria: [statement, statement],
      },
      "trace-test",
    );
    const item = await WorkItemStore.start(created.hash, "trace-test");
    const sourceCriterion = item?.completionFacts.criteria[0];
    const targetCriterion = item?.completionFacts.criteria[1];
    if (!item || !sourceCriterion || !targetCriterion) {
      throw new Error("missing duplicate criterion fixture");
    }
    const withEvidence = await WorkItemStore.addReadBackEvidence(
      item.hash,
      {
        kind: "citation_match",
        target: "https://example.com/criterion-binding",
        quotedText: "criterion-local marker",
        matchedText: "criterion-local marker",
        passed: true,
        observedAt: NOW,
        statusCode: 200,
      },
      "trace-test",
      {
        expectedAttempt: item.attempt,
        expectedBasisRef: item.completionContract.basisRef,
        criterionId: sourceCriterion.id,
      },
    );
    const evidenceId = withEvidence?.evidence.at(-1)?.id;
    if (!evidenceId) throw new Error("missing criterion-bound evidence");
    const observationId = "observation:cross-criterion-actor";
    const validation = await createDurableCompletionResultAuthorityPort().validate({
      workItemHash: item.hash,
      requestId: "request:cross-criterion-actor",
      contractRevision: item.completionContract.revision,
      basisRef: item.completionContract.basisRef,
      criterion: targetCriterion,
      result: {
        id: "result:cross-criterion-actor",
        criterionId: targetCriterion.id,
        value: "verified",
        checkedPredicate: targetCriterion.statement,
        observationIds: [observationId],
        verifierRef: "builtin.archived-quote-v1",
        basisRef: item.completionContract.basisRef,
        assumptions: [],
        residualRisks: [],
        createdAt: NOW,
      },
      observations: [
        {
          id: observationId,
          producer: "builtin.archived-quote-v1",
          subjectRef: item.hash,
          basisRef: item.completionContract.basisRef,
          artifactRefs: [evidenceId],
          provenanceRef: evidenceId,
          ancestryRefs: [],
          observedAt: NOW,
        },
      ],
    });

    expect(validation).toEqual({ ok: false });
  });

  test("scopes Worker completion identity to the retried attempt", async () => {
    const item = await startedItem("internal_chat_agent");
    const firstOutput = await evidenceBackedEnvelope(item.hash);
    const completionPolicyEngine = denyingPolicyEngine(["retry_required"], "block-first-attempt");
    await reflectCoordinatorResult(item.hash, succeeded(firstOutput), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine,
      now: () => NOW,
    });
    const firstBlocked = WorkItemStore.get(item.hash);
    for (const blocker of firstBlocked?.blockers ?? []) {
      await WorkItemStore.resolveBlocker(item.hash, blocker.id, "trace-test");
    }
    await WorkItemStore.fail(item.hash, "trace-test", "first attempt failed");
    const retried = await WorkItemStore.retry(item.hash, "trace-test");
    if (!retried) throw new Error("failed to retry WorkItem");
    expect(retried.workerRunId).toBeUndefined();
    expect(retried.workSessionId).toBeUndefined();
    const retryIdentity = await bindRetryAttempt(item.hash, 2);
    const secondOutput = await evidenceBackedEnvelope(item.hash);

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(secondOutput, retryIdentity),
      {
        sourceOrigin: { source: "internal_worker" },
        completionPolicyEngine: PolicyEngine.create(),
        now: () => NOW + 1,
      },
    );
    const stored = WorkItemStore.get(item.hash);

    expect(reflection.completionBlocked).toBe(false);
    expect(stored?.attempt).toBe(2);
    expect(stored?.completionFacts.admissions).toHaveLength(2);
    expect(stored?.completionFacts.admissions[0]?.requestId).not.toBe(
      stored?.completionFacts.admissions[1]?.requestId,
    );
    expect(stored?.completionTerminalReceipt?.admissionId).toBe(
      stored?.completionFacts.admissions[1]?.id,
    );
  });

  test.each([
    "failed",
    "cancelled",
    "interrupted",
  ] as const)("rejects a late %s result from the prior Worker assignment without mutation", async (status) => {
    const item = await startedItem("internal_chat_agent");
    await WorkItemStore.fail(item.hash, "trace-test", "retry before late terminal result");
    const retried = await WorkItemStore.retry(item.hash, "trace-test");
    if (!retried) throw new Error("failed to retry late-result fixture");
    const result: Execution.Result =
      status === "cancelled"
        ? { runId: WORKER_RUN_ID, sessionId: WORKER_SESSION_ID, status }
        : {
            runId: WORKER_RUN_ID,
            sessionId: WORKER_SESSION_ID,
            status,
            error: `late ${status}`,
          };

    const reflection = await reflectCoordinatorResult(item.hash, result, {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });
    const stored = WorkItemStore.get(item.hash);

    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("Worker completion identity mismatch");
    expect(stored?.revision).toBe(retried.revision);
    expect(stored?.failureReason).toBeUndefined();
    expect(stored?.timestamps.cancelled).toBeUndefined();
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("running");
  });

  test("fences an in-flight prior attempt when retry rotates the basis", async () => {
    const item = await startedItem("internal_chat_agent");
    const firstOutput = await evidenceBackedEnvelope(item.hash);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completionPolicyEngine = PolicyEngine.create();
    completionPolicyEngine.register({
      kind: "point",
      name: "hold-prior-attempt",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": [] },
      priority: 0,
      async fn() {
        entered.resolve();
        await release.promise;
        return PolicyDecision.allow({ policyId: "hold-prior-attempt", reasonCodes: [] });
      },
    });
    const priorAttempt = reflectCoordinatorResult(item.hash, succeeded(firstOutput), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine,
      now: () => NOW,
    });
    await entered.promise;
    await WorkItemStore.fail(item.hash, "trace-test", "retry while completion is in flight");
    await WorkItemStore.retry(item.hash, "trace-test");
    release.resolve();

    const stale = await priorAttempt;
    const afterStale = WorkItemStore.get(item.hash);
    expect(stale.completionBlocker).toContain("completion request basis is stale");
    expect(afterStale?.attempt).toBe(2);
    expect(afterStale?.completionFacts.admissions).toEqual([]);
    expect(afterStale?.completionTerminalReceipt).toBeUndefined();

    const retryIdentity = await bindRetryAttempt(item.hash, 2);
    const secondOutput = await evidenceBackedEnvelope(item.hash);
    const current = await reflectCoordinatorResult(
      item.hash,
      succeeded(secondOutput, retryIdentity),
      {
        sourceOrigin: { source: "internal_worker" },
        completionPolicyEngine: PolicyEngine.create(),
        now: () => NOW + 1,
      },
    );
    const completed = WorkItemStore.get(item.hash);

    expect(current.completionBlocked).toBe(false);
    expect(completed ? WorkItem.deriveStatus(completed) : undefined).toBe("completed");
    expect(completed?.completionFacts.admissions).toHaveLength(1);
  });

  test("does not persist a read-back that finishes after retry", async () => {
    const criterion = "archived source contains the recorded quote exactly";
    const item = await startedItem("internal_chat_agent", criterion);
    const output = JSON.stringify({
      completionReport: {
        summary: "Read-back belongs only to its initiating attempt.",
        claims: [{ statement: criterion }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
      ],
      readBackRequests: [
        {
          claimIndex: 0,
          criterionIndex: 0,
          request: {
            kind: "citation_match",
            target: "https://example.com/retry-read-back",
            quotedText: "retry marker",
          },
        },
      ],
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const priorAttempt = reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine: PolicyEngine.create(),
      now: () => NOW,
      async readBackRecorder(_hash, request) {
        entered.resolve();
        await release.promise;
        if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
        return WorkItem.ReadBackCheck.parse({
          kind: "citation_match",
          target: request.target,
          quotedText: request.quotedText,
          matchedText: request.quotedText,
          passed: true,
          observedAt: NOW,
          statusCode: 200,
        });
      },
    });
    await entered.promise;
    await WorkItemStore.fail(item.hash, "trace-test", "retry while read-back is in flight");
    await WorkItemStore.retry(item.hash, "trace-test");
    release.resolve();

    const stale = await priorAttempt;
    const stored = WorkItemStore.get(item.hash);

    expect(stale.completionBlocker).toContain("completion reservation lease lost");
    expect(stored?.attempt).toBe(2);
    expect(stored?.evidence).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
  });

  test("rejects prior-attempt claim evidence after retry", async () => {
    const item = await startedItem("internal_chat_agent");
    const firstOutput = await evidenceBackedEnvelope(item.hash);
    const completionPolicyEngine = denyingPolicyEngine(
      ["retry_with_fresh_evidence"],
      "hold-prior-attempt-evidence",
    );
    await reflectCoordinatorResult(item.hash, succeeded(firstOutput), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine,
      now: () => NOW,
    });
    const firstBlocked = WorkItemStore.get(item.hash);
    const priorEvidenceId = firstBlocked?.evidence[0]?.id;
    if (!firstBlocked || !priorEvidenceId) throw new Error("missing prior-attempt evidence");
    for (const blocker of firstBlocked.blockers) {
      await WorkItemStore.resolveBlocker(item.hash, blocker.id, "trace-test");
    }
    await WorkItemStore.fail(item.hash, "trace-test", "retry with fresh evidence");
    await WorkItemStore.retry(item.hash, "trace-test");
    const staleEvidence = await reflectCoordinatorResult(item.hash, succeeded(firstOutput), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine: PolicyEngine.create(),
      now: () => NOW + 1,
    });
    expect(staleEvidence.completionBlocker).toContain("Worker completion identity mismatch");
    for (const blocker of WorkItemStore.get(item.hash)?.blockers ?? []) {
      await WorkItemStore.resolveBlocker(item.hash, blocker.id, "trace-test");
    }
    await WorkItemStore.fail(
      item.hash,
      "trace-test",
      "retry again with a current verifier artifact",
    );
    await WorkItemStore.retry(item.hash, "trace-test");
    const retryIdentity = await bindRetryAttempt(item.hash, 3);
    const currentOutput = JSON.parse(await evidenceBackedEnvelope(item.hash)) as {
      completionReport: WorkItem.CompletionReport;
      criterionFacts: unknown[];
    };
    const mismatchedOutput = JSON.stringify({
      ...currentOutput,
      completionReport: {
        ...currentOutput.completionReport,
        claims: currentOutput.completionReport.claims.map((claim) => ({
          ...claim,
          evidenceIds: [priorEvidenceId],
        })),
      },
    });

    const replay = await reflectCoordinatorResult(
      item.hash,
      succeeded(mismatchedOutput, retryIdentity),
      {
        sourceOrigin: { source: "internal_worker" },
        completionPolicyEngine: PolicyEngine.create(),
        now: () => NOW + 1,
      },
    );
    const stored = WorkItemStore.get(item.hash);

    expect(replay.completionBlocked).toBe(true);
    expect(replay.completionBlocker).toContain(
      "completion report references evidence from a different attempt",
    );
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });

  test("re-evaluates durable citation results without repeating read-back", async () => {
    const criterion = "archived source contains the recorded quote exactly";
    const item = await startedItem("internal_chat_agent", criterion);
    const output = JSON.stringify({
      completionReport: {
        summary: "Citation result remains verifier-bound during replay.",
        claims: [{ statement: criterion }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
      ],
      readBackRequests: [
        {
          claimIndex: 0,
          criterionIndex: 0,
          request: {
            kind: "citation_match",
            target: "https://example.com/archive",
            quotedText: "durable citation marker",
          },
        },
      ],
    });
    const completionPolicyEngine = denyingPolicyEngine(
      ["hold_citation_replay"],
      "hold-citation-replay",
    );
    let readBackCalls = 0;
    const options: ReflectOptions = {
      completionService: completionService({
        policyEngine: completionPolicyEngine,
        now: () => NOW,
      }),
      sourceOrigin: { source: "internal_worker" } as const,
      now: () => NOW,
      async readBackRecorder(_hash, request) {
        readBackCalls += 1;
        if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
        return WorkItem.ReadBackCheck.parse({
          kind: "citation_match",
          target: request.target,
          quotedText: request.quotedText,
          matchedText: request.quotedText,
          passed: true,
          observedAt: NOW,
          statusCode: 200,
        });
      },
    };

    await reflectCoordinatorResult(item.hash, succeeded(output), options);
    const blocked = WorkItemStore.get(item.hash);
    if (!blocked) throw new Error("missing blocked citation WorkItem");
    const advanced = WorkItem.Info.parse({
      ...blocked,
      name: "citation head advanced",
      revision: blocked.revision + 1,
      timestamps: { ...blocked.timestamps, updated: NOW + 1 },
    });
    expect(completionWriter(blocked.hash, blocked.revision, advanced)).toBe(true);
    const replay = await reflectCoordinatorResult(item.hash, succeeded(output), options);
    const stored = WorkItemStore.get(item.hash);

    expect(replay.completionBlocked).toBe(true);
    expect(readBackCalls).toBe(1);
    expect(stored?.completionFacts.admissions).toHaveLength(2);
    expect(stored?.completionFacts.admissions[1]?.decision).toBe("block");
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });

  test("rejects an unrelated claimant statement for an indexed criterion", async () => {
    const item = await startedItem("internal_chat_agent");
    const parsed = JSON.parse(await evidenceBackedEnvelope(item.hash)) as {
      criterionFacts: Array<Record<string, unknown>>;
    };
    const fact = parsed.criterionFacts[0];
    if (!fact) throw new Error("missing criterion fact");
    fact.statement = "One equals one, therefore production was deployed.";

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(JSON.stringify(parsed)),
      { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });

  test("blocks a passing executable predicate unrelated to the persisted criterion", async () => {
    const item = await startedItem("internal_chat_agent", "deploy production");

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(await evidenceBackedEnvelope(item.hash)),
      { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.verificationErrors[0]).toMatchObject({
      code: "malformed_output",
      criterionId: stored?.completionFacts.criteria[0]?.id,
    });
    expect(stored?.completionFacts.admissions[0]).toMatchObject({
      decision: "block",
      reasonCodes: expect.arrayContaining(["verification_error"]),
    });
    expect(stored?.completionTerminalReceipt).toBeUndefined();
    expect(stored?.completionReport).toBeUndefined();
  });

  test("allows citation support because it evaluates the persisted criterion claim", async () => {
    const statement = "The release passed all checks.";
    const item = await startedItem("internal_chat_agent", statement);

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(
        await evidenceBackedEnvelope(item.hash, {
          kind: "citation_support",
          recordedInputs: { archivedText: statement },
        }),
      ),
      { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection).toMatchObject({ workItemStatus: "completed", completionBlocked: false });
    expect(stored?.completionFacts.results[0]).toMatchObject({
      value: "verified",
      verifierRef: "builtin.frozen-symbolic-nli-v1",
      checkedPredicate:
        "frozen symbolic NLI relation and directional lexical support agree with the citation",
    });
    expect(stored?.completionFacts.claims[0]?.statement).toBe(statement);
    expect(stored?.completionTerminalReceipt).toBeDefined();
  });

  test("routes connector Worker completion through the same durable admission boundary", async () => {
    const item = await startedItem("connector_endpoint");
    const result: Execution.Result = {
      ...succeeded(await evidenceBackedEnvelope(item.hash)),
      artifacts: [
        {
          kind: "connector_log",
          artifactId: "artifact:connector-completion",
          title: "Connector completion log",
          mimeType: "application/json",
        },
      ],
      logEvents: [
        {
          kind: "connector_log_event",
          artifactId: "artifact:connector-completion",
          message: "connector completed",
          sequence: 0,
          data: {},
          toolCall: {
            id: "tool:connector-completion",
            tool: "connector.finish",
            status: "completed",
          },
        },
      ],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    };

    const projection = await projectConnectorCompletion(item.hash, result, { now: () => NOW });
    const projectedEvidenceCount = WorkItemStore.get(item.hash)?.evidence.length;
    const replay = await projectConnectorCompletion(item.hash, result, { now: () => NOW });

    const stored = WorkItemStore.get(item.hash);
    expect(projection.reflection).toMatchObject({
      workItemStatus: "completed",
      completionBlocked: false,
    });
    expect(replay.reflection).toMatchObject({
      workItemStatus: "completed",
      completionBlocked: false,
    });
    expect(stored?.evidence).toHaveLength(projectedEvidenceCount ?? 0);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored?.completionFacts.admissions[0]).toMatchObject({
      origin: "worker",
      decision: "admit",
    });
    expect(stored?.completionTerminalReceipt?.admissionId).toBe(
      stored?.completionFacts.admissions[0]?.id,
    );
  });

  test("rejects duplicate criterion facts before verifier execution regardless of conflicting input order", async () => {
    for (const recordedInputs of [
      [
        { operator: "eq", left: 1, right: 1 },
        { operator: "eq", left: 1, right: 2 },
      ],
      [
        { operator: "eq", left: 1, right: 2 },
        { operator: "eq", left: 1, right: 1 },
      ],
    ]) {
      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });
      const item = await startedItem("internal_chat_agent");
      const criterion = item.completionFacts.criteria[0];
      if (!criterion) throw new Error("missing completion criterion");

      const evidenceIds: string[] = [];
      for (const inputs of recordedInputs) {
        const withEvidence = await WorkItemStore.addEvidence(
          item.hash,
          {
            kind: "test_result",
            description: "conflicting durable verifier input",
            passed: inputs.right === 1,
            detail: JSON.stringify({
              type: "verifier_recorded_inputs",
              version: 1,
              workItemHash: item.hash,
              basisRef: item.completionContract.basisRef,
              criterionId: criterion.id,
              verifierKind: "numeric_recheck",
              recordedInputs: inputs,
            }),
          },
          "trace-test",
        );
        const evidenceId = withEvidence?.evidence.at(-1)?.id;
        if (!evidenceId) throw new Error("missing verifier evidence");
        evidenceIds.push(evidenceId);
      }
      const output = JSON.stringify({
        completionReport: {
          summary: "Conflicting duplicate facts must not choose a winner.",
          claims: [{ statement: criterion.statement, evidenceIds }],
        },
        criterionFacts: evidenceIds.map((evidenceId) => ({
          criterionIndex: 0,
          evidenceRefs: [{ source: "work_item", evidenceId }],
          verification: { kind: "numeric_recheck" },
        })),
        readBackRequests: [
          {
            claimIndex: 0,
            criterionIndex: 0,
            request: {
              kind: "citation_match",
              target: "http://example.com/never-read",
              quotedText: "duplicate facts reject before read-back",
            },
          },
        ],
      });
      let readBackExecuted = false;

      const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW,
        async readBackRecorder() {
          readBackExecuted = true;
          throw new Error("read-back must not execute");
        },
      });

      const stored = WorkItemStore.get(item.hash);
      expect(reflection.completionBlocked).toBe(true);
      expect(reflection.completionBlocker).toContain("criterionIndex 0");
      expect(readBackExecuted).toBe(false);
      expect(stored?.completionFacts).toMatchObject({
        results: [],
        claims: [],
        observations: [],
        verificationErrors: [],
        admissions: [],
      });
      expect(stored?.completionReport).toBeUndefined();
      expect(stored?.completionTerminalReceipt).toBeUndefined();
    }
  });

  test("rejects cross-criterion reuse of one read-back evidence binding", async () => {
    const predicate = "archived source contains the recorded quote exactly";
    const created = await WorkItemStore.create(
      {
        name: "Cross-criterion read-back binding",
        sourceMessageId: "dispatch:cross-criterion-read-back",
        sourceChannel: "dispatch",
        intent: "worker.spawn",
        goal: "prove criterion-local read-back binding",
        executorKind: "internal_chat_agent",
        workSessionId: WORKER_SESSION_ID,
        workerRunId: WORKER_RUN_ID,
        acceptanceCriteria: [predicate, predicate],
      },
      "trace-test",
    );
    const item = await WorkItemStore.start(created.hash, "trace-test");
    if (!item) throw new Error("missing started WorkItem");
    const output = JSON.stringify({
      completionReport: {
        summary: "One read-back cannot satisfy two criterion IDs.",
        claims: [{ statement: predicate }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
        {
          criterionIndex: 1,
          evidenceRefs: [{ source: "read_back", requestIndex: 0 }],
          verification: { kind: "archived_quote_match" },
        },
      ],
      readBackRequests: [
        {
          claimIndex: 0,
          criterionIndex: 0,
          request: {
            kind: "citation_match",
            target: "http://example.com/read-back",
            quotedText: "bound marker",
          },
        },
      ],
    });

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      completionPolicyEngine: COMPLETION_POLICY_ENGINE,
      now: () => NOW,
      async readBackRecorder(_hash, request) {
        if (request.kind !== "citation_match") throw new Error("unexpected read-back kind");
        return WorkItem.ReadBackCheck.parse({
          kind: "citation_match",
          target: request.target,
          quotedText: request.quotedText,
          matchedText: request.quotedText,
          passed: true,
          observedAt: NOW,
          statusCode: 200,
        });
      },
    });

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("criterion binding");
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionTerminalReceipt).toBeUndefined();
    expect(stored?.completionReport).toBeUndefined();
  });

  test("rejects unknown authority-shaped completion envelope fields", async () => {
    const cases = [
      {
        name: "top-level",
        mutate(envelope: Record<string, unknown>) {
          envelope.policyDecision = "allow";
        },
      },
      {
        name: "completion report",
        mutate(envelope: Record<string, unknown>) {
          const report = envelope.completionReport as Record<string, unknown>;
          report.admissionId = "claimant:admission";
        },
      },
      {
        name: "completion claim",
        mutate(envelope: Record<string, unknown>) {
          const report = envelope.completionReport as { claims: Array<Record<string, unknown>> };
          const claim = report.claims[0];
          if (!claim) throw new Error("missing completion claim");
          claim.verified = true;
        },
      },
    ] as const;

    for (const testCase of cases) {
      Storage.reset();
      Storage.initialize({ dbPath: ":memory:" });
      const item = await startedItem("internal_chat_agent");
      const envelope = JSON.parse(await evidenceBackedEnvelope(item.hash)) as Record<
        string,
        unknown
      >;
      testCase.mutate(envelope);

      const reflection = await reflectCoordinatorResult(
        item.hash,
        succeeded(JSON.stringify(envelope)),
        { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
      );

      const stored = WorkItemStore.get(item.hash);
      expect(reflection.completionBlocked, testCase.name).toBe(true);
      expect(stored?.completionFacts.results, testCase.name).toEqual([]);
      expect(stored?.completionFacts.admissions, testCase.name).toEqual([]);
      expect(stored?.completionTerminalReceipt, testCase.name).toBeUndefined();
    }
  });

  test("blocks a succeeded Worker envelope with missing criterion facts", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = await evidenceBackedEnvelope(item.hash);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    Reflect.deleteProperty(parsed, "criterionFacts");

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(JSON.stringify(parsed)),
      {
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW,
      },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("criterionFacts");
    expect(stored?.completionFacts.admissions).toEqual([]);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("blocked");
  });

  test("records verifier errors and blocks instead of trusting an invalid claimed fact", async () => {
    const item = await startedItem("internal_chat_agent");

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(
        await evidenceBackedEnvelope(item.hash, {
          kind: "numeric_recheck",
          recordedInputs: { operator: "eq", left: 1 },
        }),
      ),
      {
        sourceOrigin: { source: "internal_worker" },
        now: () => NOW,
      },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.verificationErrors[0]).toMatchObject({
      code: "malformed_input",
      criterionId: stored?.completionFacts.criteria[0]?.id,
    });
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions[0]).toMatchObject({
      decision: "block",
      reasonCodes: expect.arrayContaining(["verification_error"]),
    });
    expect(stored?.completionTerminalReceipt).toBeUndefined();
    expect(stored?.completionReport).toBeUndefined();
  });

  test("rejects claimant-fabricated inline verifier inputs", async () => {
    const item = await startedItem("internal_chat_agent");
    const withEvidence = await WorkItemStore.addEvidence(
      item.hash,
      {
        kind: "test_result",
        description: "terminal prose evidence only",
        passed: true,
      },
      "trace-test",
    );
    const evidenceId = withEvidence?.evidence.at(-1)?.id;
    if (!evidenceId) throw new Error("missing terminal evidence");
    const output = JSON.stringify({
      completionReport: {
        summary: "Hostile claimant says the check passed.",
        claims: [{ statement: "Forged verification.", evidenceIds: [evidenceId] }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          verification: {
            kind: "numeric_recheck",
            recordedInputs: { operator: "eq", left: 7, right: 7 },
          },
        },
      ],
    });

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });

  test("rejects a missing WorkItem-local verifier evidence reference", async () => {
    const item = await startedItem("internal_chat_agent");
    const output = JSON.stringify({
      completionReport: {
        summary: "Missing evidence must not verify.",
        claims: [{ statement: "Missing evidence.", evidenceIds: ["evidence:missing"] }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "work_item", evidenceId: "evidence:missing" }],
          verification: { kind: "numeric_recheck" },
        },
      ],
    });

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("verifier evidence not found");
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
  });

  test("rejects verifier evidence bound to a different criterion", async () => {
    const item = await startedItem("internal_chat_agent");
    const criterion = item.completionFacts.criteria[0];
    if (!criterion) throw new Error("missing criterion");
    const withEvidence = await WorkItemStore.addEvidence(
      item.hash,
      {
        kind: "verification",
        description: "mismatched verifier input",
        passed: true,
        detail: JSON.stringify({
          type: "verifier_recorded_inputs",
          version: 1,
          workItemHash: item.hash,
          basisRef: item.completionContract.basisRef,
          criterionId: `${criterion.id}:foreign`,
          verifierKind: "numeric_recheck",
          recordedInputs: { operator: "eq", left: 1, right: 1 },
        }),
      },
      "trace-test",
    );
    const evidenceId = withEvidence?.evidence.at(-1)?.id;
    if (!evidenceId) throw new Error("missing evidence");
    const output = JSON.stringify({
      completionReport: {
        summary: "Mismatched evidence must not verify.",
        claims: [{ statement: "Mismatched evidence.", evidenceIds: [evidenceId] }],
      },
      criterionFacts: [
        {
          criterionIndex: 0,
          evidenceRefs: [{ source: "work_item", evidenceId }],
          verification: { kind: "numeric_recheck" },
        },
      ],
    });

    const reflection = await reflectCoordinatorResult(item.hash, succeeded(output), {
      sourceOrigin: { source: "internal_worker" },
      now: () => NOW,
    });

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(reflection.completionBlocker).toContain("verifier evidence does not match criterion");
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
  });

  test("rejects claimant-supplied non-asserted values before authority evaluation", async () => {
    const item = await startedItem("internal_chat_agent");
    const parsed = JSON.parse(await evidenceBackedEnvelope(item.hash)) as {
      criterionFacts: Array<Record<string, unknown>>;
    };
    const fact = parsed.criterionFacts[0];
    if (!fact) throw new Error("missing criterion fact");
    fact.value = "verified";

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(JSON.stringify(parsed)),
      { sourceOrigin: { source: "internal_worker" }, now: () => NOW },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results).toEqual([]);
    expect(stored?.completionFacts.admissions).toEqual([]);
  });

  test("carries kernel-computed Stakes into asserted-result escalation", async () => {
    const item = await startedItem("internal_chat_agent");
    const window = Stakes.createWindow({
      ownerKey: "owner:worker-completion",
      windowId: "window:worker-completion",
      openedAt: 1,
      closesAt: 10,
    });
    const stakes = Stakes.compute(
      {
        actionId: "action:worker-completion",
        ownerKey: window.ownerKey,
        windowRef: window.windowRef,
        ledgerObservedAt: 2,
        facts: {
          irreversibleChangeCount: 10,
          externalSurfaceCount: 10,
          spendMicros: 100_000_000,
          budgetReservedMicros: 100_000_000,
          outreachRecipientCount: 10,
          contentFingerprints: [
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ],
        },
      },
      { window, actions: [], knownFingerprints: [] },
    );
    let resolvedSubject: unknown;

    const reflection = await reflectCoordinatorResult(
      item.hash,
      succeeded(
        await evidenceBackedEnvelope(item.hash, {
          kind: "reasoning",
          recordedInputs: {},
        }),
      ),
      {
        sourceOrigin: { source: "internal_worker" },
        stakesResolver: {
          resolve(subject) {
            resolvedSubject = subject;
            return {
              ok: true,
              context: { surface: "work.complete.pre", ...subject, stakes },
            };
          },
        },
        now: () => NOW,
      },
    );

    const stored = WorkItemStore.get(item.hash);
    expect(resolvedSubject).toMatchObject({ workItemHash: item.hash });
    expect(reflection.completionBlocked).toBe(true);
    expect(stored?.completionFacts.results[0]).toMatchObject({ value: "asserted" });
    expect("checkedPredicate" in (stored?.completionFacts.results[0] ?? {})).toBe(false);
    expect(stored?.completionFacts.admissions[0]).toMatchObject({
      decision: "escalate",
      stakesRef: stakes.reference,
    });
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });
});
