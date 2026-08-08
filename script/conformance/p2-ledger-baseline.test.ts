import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wait, WorkItem } from "../../packages/protocol/src/index";
import {
  createCompletionAdmissionService,
  completionRequestRoot,
} from "../../packages/openomni/src/work-item/completion-admission";
import { DispatchRegistry } from "../../packages/openomni/src/dispatch/registry";
import { registerBuiltInDispatchHandlers } from "../../packages/openomni/src/dispatch/setup";
import {
  Bus,
  SqliteStorageAdapter,
  Storage,
  WaitStore,
  WorkerRun,
  WorkerRunStateStore,
  WorkItemStore,
} from "../../packages/session/src/index";
import { Ledger } from "../../packages/session/src/ledger-core/index";

/**
 * #510 phase B/C1 conformance — the Wait and WorkItem decision classes
 * against the clean ledger baseline ("no record, no action"):
 *
 *   (a) append-before-act: every committed transition has its
 *       decision-class fact on the owner stream (`wait:<id>` /
 *       `work:<hash>`) at seq === projected revision, and a failed append
 *       leaves no projection change and no Bus event;
 *   (b) a stale expectedHead is a typed conflict (revision_conflict /
 *       stale_revision at the store, cas_conflict at the append core) that
 *       writes nothing;
 *   (c) pre-cutover WorkItem rows (backfilled to revision 1 with an empty
 *       stream) are adopted lazily by a work_item.adopted genesis fact;
 *   (d) completion admission verdicts — accept AND refuse — are appended
 *       facts, with the accept verdict recorded before the terminal
 *       projection;
 *   (e) boot tail verification covers wait: and work: streams and detects
 *       tampered rows.
 *
 * Ledger and session sources are imported by path (not the package entry)
 * so every module — including the non-exported ledger core — resolves to
 * one instance.
 */

let tempDir: string;
let inspect: Database;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  tempDir = mkdtempSync(join(tmpdir(), "p2-ledger-baseline-"));
  Storage.initialize({ dbPath: join(tempDir, "openomni.db") });
  // Second connection on the same WAL file: assertions and tampering must
  // not ride the writer's connection.
  inspect = new Database(join(tempDir, "openomni.db"));
});

afterEach(() => {
  inspect.close();
  const adapter = Storage.getAdapter();
  if (adapter instanceof SqliteStorageAdapter) adapter.close();
  Storage.reset();
  Bus.reset();
  rmSync(tempDir, { recursive: true, force: true });
});

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

function buildWaitCreate(overrides: Partial<Wait.Create> = {}): Wait.Create {
  return {
    id: "wait-1",
    ownerRef: { kind: "workItem", id: "wi-1" },
    originMessageId: "out-msg-1",
    correlation: { tokenHash: "tok-1" },
    allowedActions: ["report_result"],
    expectedResponders: ["actor-a"],
    resolutionPolicy: "first_reply",
    expiresAt: 10_000,
    followUpWindow: 1_000,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function buildReplyInput(overrides: Partial<Wait.ReplyInput> = {}): Wait.ReplyInput {
  return {
    replyKey: "reply-key-1",
    responderCandidates: ["actor-a"],
    messageId: "in-msg-1",
    at: 1_000,
    ...overrides,
  };
}

interface FactRow {
  readonly seq: number;
  readonly type: string;
  readonly data: string;
}

function factsOfStream(streamId: string): FactRow[] {
  return inspect
    .query("SELECT seq, type, data FROM ledger_event WHERE stream_id = ? ORDER BY seq ASC")
    .all(streamId) as FactRow[];
}

function headOfStream(streamId: string): number | undefined {
  const row = inspect.query("SELECT head FROM ledger_head WHERE stream_id = ?").get(streamId) as {
    head: number;
  } | null;
  return row?.head;
}

function factsOf(waitId: string): FactRow[] {
  return factsOfStream(`wait:${waitId}`);
}

function headOf(waitId: string): number | undefined {
  return headOfStream(`wait:${waitId}`);
}

function workFactsOf(hash: string): FactRow[] {
  return factsOfStream(`work:${hash}`);
}

function workHeadOf(hash: string): number | undefined {
  return headOfStream(`work:${hash}`);
}

function captureStoreError(fn: () => unknown): InstanceType<typeof Wait.StoreError> {
  try {
    fn();
  } catch (error) {
    if (Wait.StoreError.isInstance(error)) return error;
    throw error;
  }
  throw new Error("expected WaitStoreError, but nothing was thrown");
}

describe("p2 ledger baseline — Wait decision-class facts", () => {
  test("append-before-act: every committed transition appends its fact at seq === projected revision", () => {
    const created = WaitStore.create(buildWaitCreate());
    const resolved = WaitStore.attachReply("wait-1", buildReplyInput());
    if (resolved.kind !== "resolved") throw new Error(`expected resolved, got ${resolved.kind}`);

    const facts = factsOf("wait-1");
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([
      [1, "wait.opened"],
      [2, "wait.resolved"],
    ]);
    // Head↔revision binding: the stream head IS the projected revision.
    expect(created.revision).toBe(1);
    expect(resolved.record.revision).toBe(2);
    expect(headOf("wait-1")).toBe(2);
    expect(WaitStore.get("wait-1")?.revision).toBe(2);

    // The fact stores the outcome's typed payload plus the resulting
    // revision — never the record snapshot (the projection row stays the
    // read model).
    const opened = JSON.parse(facts[0]?.data ?? "{}") as Record<string, unknown>;
    expect(opened).toEqual({
      ownerKind: "workItem",
      ownerId: "wi-1",
      originMessageId: "out-msg-1",
      expiresAt: 10_000,
      revision: 1,
    });
    const resolvedFact = JSON.parse(facts[1]?.data ?? "{}") as Record<string, unknown>;
    expect(resolvedFact).toMatchObject({
      replyKey: "reply-key-1",
      responderId: "actor-a",
      responders: 1,
      threshold: 1,
      resolvedAt: 1_000,
      revision: 2,
    });
    expect(Object.keys(resolvedFact)).not.toContain("replies");
    expect(Object.keys(resolvedFact)).not.toContain("correlation");
  });

  test("a failed append leaves no projection change, no extra fact, and no Bus event", async () => {
    WaitStore.create(buildWaitCreate());
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    // A concurrent writer advances the stream between the read and the
    // append: the appended cancel fact wins, the outer expire must fail as
    // a typed revision_conflict with nothing written.
    const error = captureStoreError(() =>
      WaitStore.transition("wait-1", (record) => {
        WaitStore.cancel("wait-1", 500);
        return Wait.expire(record, { at: 20_000 });
      }),
    );

    expect(error.data.code).toBe("revision_conflict");
    const persisted = WaitStore.get("wait-1");
    expect(persisted?.status).toBe("cancelled");
    expect(persisted?.revision).toBe(2);
    // The CAS receipt and the ledger head never disagree: only the inner
    // cancel appended (seq 2); the failed expire left no fact behind.
    expect(headOf("wait-1")).toBe(2);
    expect(factsOf("wait-1").map((fact) => fact.type)).toEqual(["wait.opened", "wait.cancelled"]);
    await flushBus();
    expect(events).toContain("wait.cancelled");
    expect(events).not.toContain("wait.expired");
  });

  test("a stale expectedHead at the append core is a typed cas_conflict that writes nothing", () => {
    WaitStore.create(buildWaitCreate());

    const conflict = Ledger.append(
      inspect,
      { streamId: "wait:wait-1", type: "wait.cancelled", data: { revision: 1 } },
      0,
    );

    expect(conflict).toEqual({ kind: "cas_conflict", currentHead: 1 });
    expect(factsOf("wait-1")).toHaveLength(1);
    expect(headOf("wait-1")).toBe(1);
  });

  test("a duplicate create conflicts on the owner stream and projects nothing", async () => {
    WaitStore.create(buildWaitCreate());
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    const error = captureStoreError(() =>
      WaitStore.create(buildWaitCreate({ originMessageId: "out-msg-2" })),
    );

    expect(error.data.code).toBe("duplicate");
    expect(factsOf("wait-1")).toHaveLength(1);
    expect(headOf("wait-1")).toBe(1);
    expect(WaitStore.get("wait-1")?.originMessageId).toBe("out-msg-1");
    await flushBus();
    expect(events).not.toContain("wait.opened");
  });

  test("boot tail verification passes after a normal run and detects a tampered row", () => {
    WaitStore.create(buildWaitCreate());
    WaitStore.attachReply("wait-1", buildReplyInput());
    WaitStore.create(buildWaitCreate({ id: "wait-2", originMessageId: "out-msg-2" }));
    WaitStore.expire("wait-2", 10_001);

    expect(Ledger.verifyTail(inspect)).toEqual([]);

    inspect
      .query("UPDATE ledger_event SET data = ? WHERE stream_id = ? AND seq = ?")
      .run('{"partial":true,"revision":2}', "wait:wait-2", 2);

    const breaks = Ledger.verifyTail(inspect);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      streamId: "wait:wait-2",
      seq: 2,
      code: "hash_mismatch",
    });
  });
});

async function createConformanceWorkItem(name: string): Promise<WorkItem.Info> {
  return WorkItemStore.create({
    name,
    sourceMessageId: `msg_${name}`,
    sourceChannel: "conformance",
    intent: "verify",
    goal: "prove no record, no action for the WorkItem class",
    sessionId: "session_conformance",
    acceptanceCriteria: ["the transition is recorded before it acts"],
  });
}

function buildCompletionRequest(item: WorkItem.Info): WorkItem.CompletionRequest {
  const criterion = item.completionFacts.criteria[0];
  const evidenceId = item.evidence[0]?.id;
  if (!criterion || !evidenceId) throw new Error("missing completion criterion evidence");
  const observationId = `observation:${item.hash}:${item.revision}`;
  const basisRef = item.completionContract.basisRef;
  return WorkItem.CompletionRequest.parse({
    version: 1,
    id: `completion-request:${item.hash}:${item.revision}:worker`,
    origin: "worker",
    workItemHash: item.hash,
    contractRevision: item.completionContract.revision,
    basisRef,
    expectedHead: item.revision,
    claims: [
      {
        id: `claim:${item.hash}:${item.revision}`,
        criterionId: criterion.id,
        statement: criterion.statement,
        observationIds: [observationId],
        basisRef,
        createdAt: item.timestamps.updated,
      },
    ],
    observations: [
      {
        id: observationId,
        producer: "conformance:p2",
        subjectRef: item.hash,
        basisRef,
        artifactRefs: [evidenceId],
        provenanceRef: evidenceId,
        ancestryRefs: [],
        observedAt: item.timestamps.updated,
      },
    ],
    results: [
      {
        id: `result:${item.hash}:${item.revision}`,
        criterionId: criterion.id,
        value: "verified",
        checkedPredicate: criterion.statement,
        observationIds: [observationId],
        verifierRef: "verifier:conformance",
        assumptions: [],
        basisRef,
        residualRisks: [],
        createdAt: item.timestamps.updated,
      },
    ],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  });
}

function buildAdmission(
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  decision: "admit" | "block",
): WorkItem.CompletionAdmission {
  return WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${request.id}:${item.revision + 1}:${decision}`,
    requestId: request.id,
    workItemHash: request.workItemHash,
    requestRoot: completionRequestRoot(request),
    proposedFactIds: {
      claims: request.claims.map(({ id }) => id),
      observations: request.observations.map(({ id }) => id),
      results: request.results.map(({ id }) => id),
      invalidations: [],
      verificationErrors: [],
      effects: [],
    },
    origin: request.origin,
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    effectiveResultIds: decision === "admit" ? request.results.map(({ id }) => id) : [],
    unresolvedCriterionIds:
      decision === "admit" ? [] : item.completionFacts.criteria.map(({ id }) => id),
    decision,
    reasonCodes: decision === "admit" ? [] : ["completion_block"],
    residualRisks: [],
    policyRef: "policy:conformance",
    expectedHead: item.revision,
    recordedHead: item.revision + 1,
    createdAt: item.timestamps.updated + 1,
  });
}

describe("p2 ledger baseline — WorkItem decision-class facts", () => {
  test("append-before-act: create and every lifecycle transition append their facts at seq === projected revision", async () => {
    const item = await createConformanceWorkItem("append-before-act");
    await WorkItemStore.start(item.hash);
    const blocked = await WorkItemStore.addBlocker(item.hash, {
      kind: "external",
      description: "awaiting conformance reply",
    });
    const blockerId = blocked?.blockers[0]?.id;
    if (!blockerId) throw new Error("missing conformance blocker");
    await WorkItemStore.resolveBlocker(item.hash, blockerId);
    await WorkItemStore.fail(item.hash, "conformance failure");

    const facts = workFactsOf(item.hash);
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([
      [1, "work_item.created"],
      [2, "work_item.started"],
      [3, "work_item.blocker_added"],
      [4, "work_item.blocker_resolved"],
      [5, "work_item.failed"],
    ]);
    // Head↔revision binding: the stream head IS the projected revision.
    expect(item.revision).toBe(1);
    expect(WorkItemStore.get(item.hash)?.revision).toBe(5);
    expect(workHeadOf(item.hash)).toBe(5);

    // Facts carry the typed transition payload plus the resulting revision —
    // never the row snapshot (the projection row stays the read model).
    const failed = JSON.parse(facts[4]?.data ?? "{}") as Record<string, unknown>;
    expect(failed).toMatchObject({ reason: "conformance failure", revision: 5 });
    expect(Object.keys(failed)).not.toContain("acceptanceCriteria");
    expect(Object.keys(failed)).not.toContain("completionFacts");
  });

  test("a failed append leaves no projection change, no extra fact, and no Bus event", async () => {
    const item = await createConformanceWorkItem("failed-append");
    const storage = Storage.getAdapter();
    const workItem = storage.workItem;
    const ledger = storage.ledger;
    if (!workItem || !ledger) throw new Error("conformance storage misses sub-adapters");

    // A competing writer lands a FULL append+CAS write between the store's
    // read and its transaction: the outer fail() must observe a stale head
    // at the append, throw the typed stale_revision error, and write nothing.
    const originalGet = workItem.get.bind(workItem);
    let injected = false;
    workItem.get = (hash: string) => {
      const current = originalGet(hash);
      if (hash === item.hash && current && !injected) {
        injected = true;
        storage.transaction(() => {
          const appended = ledger.append(
            {
              streamId: `work:${item.hash}`,
              type: "work_item.updated",
              data: { fields: ["name"], revision: current.revision + 1 },
            },
            current.revision,
          );
          if (appended.kind !== "appended") throw new Error("competing append must win");
          if (
            !workItem.compareAndSet(item.hash, current.revision, {
              ...current,
              revision: current.revision + 1,
              name: "competing winner",
            })
          ) {
            throw new Error("competing projection must win");
          }
        });
      }
      return current;
    };
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    let thrown: unknown;
    try {
      await WorkItemStore.fail(item.hash, "loser");
    } catch (error) {
      thrown = error;
    }

    expect(injected).toBe(true);
    expect(thrown).toMatchObject({ name: "WorkItemRevisionError", code: "stale_revision" });
    const persisted = originalGet(item.hash);
    expect(persisted?.name).toBe("competing winner");
    expect(persisted?.revision).toBe(2);
    expect(persisted?.failureReason).toBeUndefined();
    // Only the competing write appended: the failed transition left no fact.
    expect(workHeadOf(item.hash)).toBe(2);
    expect(workFactsOf(item.hash).map((fact) => fact.type)).toEqual([
      "work_item.created",
      "work_item.updated",
    ]);
    await flushBus();
    expect(events).not.toContain("work_item.failed");
    expect(events).not.toContain("work_item.status_changed");
  });

  test("a pre-cutover row is adopted lazily: genesis fact carries the observed snapshot", async () => {
    const item = await createConformanceWorkItem("lazy-adoption");
    // Simulate a migration-backfilled pre-cutover row: projection at
    // revision 1 with an EMPTY owner stream (0014 backfills every existing
    // row to revision 1).
    inspect.query("DELETE FROM ledger_event WHERE stream_id = ?").run(`work:${item.hash}`);
    inspect.query("DELETE FROM ledger_head WHERE stream_id = ?").run(`work:${item.hash}`);
    expect(workFactsOf(item.hash)).toHaveLength(0);

    const started = await WorkItemStore.start(item.hash);

    expect(started?.revision).toBe(2);
    const facts = workFactsOf(item.hash);
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([
      [1, "work_item.adopted"],
      [2, "work_item.started"],
    ]);
    expect(workHeadOf(item.hash)).toBe(2);
    const adopted = JSON.parse(facts[0]?.data ?? "{}") as {
      snapshot?: { hash?: string; revision?: number };
      revision?: number;
    };
    // The genesis fact records the observed state at seq 1 == revision 1 —
    // pre-cutover history is adopted, never fabricated.
    expect(adopted.revision).toBe(1);
    expect(adopted.snapshot?.hash).toBe(item.hash);
    expect(adopted.snapshot?.revision).toBe(1);
  });

  test("completion admission verdicts are appended facts: refuse is recorded, accept precedes the terminal projection", async () => {
    const refused = await createConformanceWorkItem("admission-refused");
    await WorkItemStore.addEvidence(refused.hash, {
      kind: "verification",
      description: "conformance evidence",
      passed: true,
    });
    const refusedCurrent = WorkItemStore.get(refused.hash);
    if (!refusedCurrent) throw new Error("missing refused conformance item");
    const refusedRequest = buildCompletionRequest(refusedCurrent);
    const report: WorkItem.CompletionReport = {
      summary: "Completed through conformance admission.",
      claims: [
        {
          statement: refusedCurrent.completionFacts.criteria[0]?.statement ?? "",
          evidenceIds: [refusedCurrent.evidence[0]?.id ?? ""],
        },
      ],
      caveats: [],
      followUps: [],
    };
    // Re-initializing with the same dbPath returns the completion writer for
    // the already-configured storage.
    const completionWriter = Storage.initialize({ dbPath: join(tempDir, "openomni.db") });
    const blockService = createCompletionAdmissionService({
      completionWriter,
      now: () => Date.now(),
      decision: (item, request) => Promise.resolve(buildAdmission(item, request, "block")),
    });

    const refusal = await blockService.requestCompletion(refusedRequest, report);

    expect(refusal.completed).toBe(false);
    const refusedFacts = workFactsOf(refused.hash);
    const refusalFact = refusedFacts.at(-1);
    expect(refusalFact?.type).toBe("work_item.admission_refused");
    expect(refusalFact?.seq).toBe(WorkItemStore.get(refused.hash)?.revision);
    expect(JSON.parse(refusalFact?.data ?? "{}")).toMatchObject({
      requestId: refusedRequest.id,
      decision: "block",
    });
    expect(WorkItemStore.get(refused.hash)?.completionTerminalReceipt).toBeUndefined();
    expect(refusedFacts.map((fact) => fact.type)).not.toContain("work_item.completed");

    const admitted = await createConformanceWorkItem("admission-accepted");
    await WorkItemStore.addEvidence(admitted.hash, {
      kind: "verification",
      description: "conformance evidence",
      passed: true,
    });
    const admittedCurrent = WorkItemStore.get(admitted.hash);
    if (!admittedCurrent) throw new Error("missing admitted conformance item");
    const admittedRequest = buildCompletionRequest(admittedCurrent);
    const admittedReport: WorkItem.CompletionReport = {
      summary: "Completed through conformance admission.",
      claims: [
        {
          statement: admittedCurrent.completionFacts.criteria[0]?.statement ?? "",
          evidenceIds: [admittedCurrent.evidence[0]?.id ?? ""],
        },
      ],
      caveats: [],
      followUps: [],
    };
    const admitService = createCompletionAdmissionService({
      completionWriter,
      now: () => Date.now(),
      decision: (item, request) => Promise.resolve(buildAdmission(item, request, "admit")),
    });

    const admission = await admitService.requestCompletion(admittedRequest, admittedReport);

    expect(admission.completed).toBe(true);
    // Record-before-terminal: the accept verdict fact precedes the terminal
    // completion fact on the same owner stream.
    const admittedFacts = workFactsOf(admitted.hash).map((fact) => fact.type);
    const acceptedAt = admittedFacts.indexOf("work_item.admission_accepted");
    const completedAt = admittedFacts.indexOf("work_item.completed");
    expect(acceptedAt).toBeGreaterThan(-1);
    expect(completedAt).toBe(acceptedAt + 1);
    expect(workHeadOf(admitted.hash)).toBe(WorkItemStore.get(admitted.hash)?.revision);
    expect(WorkItemStore.get(admitted.hash)?.completionTerminalReceipt).toBeDefined();
  });

  test("boot tail verification covers work: streams and detects a tampered row", async () => {
    const item = await createConformanceWorkItem("tail-verify");
    await WorkItemStore.start(item.hash);

    expect(Ledger.verifyTail(inspect)).toEqual([]);

    inspect
      .query("UPDATE ledger_event SET data = ? WHERE stream_id = ? AND seq = ?")
      .run('{"startedAt":0,"revision":2}', `work:${item.hash}`, 2);

    const breaks = Ledger.verifyTail(inspect);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      streamId: `work:${item.hash}`,
      seq: 2,
      code: "hash_mismatch",
    });
  });
});

function conformanceAttemptIdentity(workInput: string) {
  return {
    contentFingerprint: WorkItem.contentFingerprintOf({
      workInput,
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true, reason: "not captured by the conformance suite" },
      model: {
        provider: "anthropic",
        id: "claude-conformance",
        parameters: { absent: true, reason: "no model parameters configured" },
      },
      upstreamFingerprints: [],
      dependencyLock: { absent: true, reason: "not read by the conformance suite" },
    }),
    environmentFingerprint: WorkItem.environmentFingerprintOf({
      os: process.platform,
      arch: process.arch,
      bunVersion: process.versions.bun ?? process.version,
      workspaceRoot: { absent: true, reason: "no workspace in the conformance suite" },
      schemaVersions: { policyKernel: 1 },
      policy: { absent: true, reason: "no policy plan in the conformance suite" },
      toolVersions: { absent: true, reason: "not enumerated by the conformance suite" },
      verifierVersions: { absent: true, reason: "not enumerated by the conformance suite" },
      providerParameters: { absent: true, reason: "no provider parameters configured" },
      configRef: { absent: true, reason: "no config identity in the conformance suite" },
    }),
  };
}

describe("p2 ledger baseline — attempt identity decision-class facts (C2)", () => {
  test("worker.spawn appends work_item.attempt_allocated before the WorkerRun record exists", async () => {
    const observations: {
      factTypes: string[];
      factAttemptId?: string;
      workerRunExisted: boolean;
    }[] = [];
    const registry = new DispatchRegistry();
    registerBuiltInDispatchHandlers(registry, {
      owners: {
        coordinator: {
          dispatch: async (sessionId, request) => {
            const spawned = WorkItemStore.list().find(
              (candidate) => candidate.workerRunId === request.runId,
            );
            if (!spawned) throw new Error("spawned WorkItem not found at dispatch time");
            const facts = factsOfStream(`work:${spawned.hash}`);
            const allocated = facts.find((fact) => fact.type === "work_item.attempt_allocated");
            observations.push({
              factTypes: facts.map((fact) => fact.type),
              factAttemptId: allocated
                ? (JSON.parse(allocated.data) as { attemptId?: string }).attemptId
                : undefined,
              workerRunExisted: WorkerRunStateStore.get(sessionId, request.runId) !== undefined,
            });
            // The executor acts only now — this is where the durable
            // WorkerRun record is created today, strictly AFTER the
            // appended attempt fact (append-before-act at the spawn site).
            await WorkerRun.create(sessionId, {
              runId: request.runId,
              title: "conformance worker",
              prompt: request.prompt,
            });
            return { runId: request.runId, sessionId, status: "succeeded", output: "done" };
          },
        },
      },
    });

    const handler = registry.get("worker.spawn");
    if (!handler) throw new Error("worker.spawn handler is not registered");
    const result = (await handler({
      dispatchId: "dispatch-worker-spawn-c2",
      action: "worker.spawn",
      target: { kind: "worker", name: "conformance-coder" },
      payload: {
        text: "prove attempt identity",
        acceptanceCriteria: ["the attempt identity is recorded before the run exists"],
      },
      actor: { kind: "resident", actorId: "agent:resident", agentName: "resident" },
      traceId: "trace-c2",
      submittedAt: Date.now(),
    })) as {
      output: { workItemHash: string; attemptId: string; runId: string; sessionId: string };
    };

    expect(observations).toHaveLength(1);
    const observed = observations[0];
    expect(observed?.workerRunExisted).toBe(false);
    expect(observed?.factTypes).toContain("work_item.attempt_allocated");
    // attemptId is threaded alongside workerRunId and matches the appended fact.
    expect(result.output.attemptId).toBeDefined();
    expect(observed?.factAttemptId).toBe(result.output.attemptId);
    expect(WorkerRunStateStore.get(result.output.sessionId, result.output.runId)).toBeDefined();
    // Head↔revision binding holds through the allocation fact.
    expect(workHeadOf(result.output.workItemHash)).toBe(
      WorkItemStore.get(result.output.workItemHash)?.revision,
    );
  });

  test("attemptSeq is allocated by the serialized append: monotonic, never reused", async () => {
    const item = await createConformanceWorkItem("attempt-seq-monotonic");

    const first = await WorkItemStore.allocateAttempt(
      item.hash,
      conformanceAttemptIdentity("first execution"),
    );
    const second = await WorkItemStore.allocateAttempt(
      item.hash,
      conformanceAttemptIdentity("second execution"),
    );
    if (!first || !second) throw new Error("expected two allocations");

    expect(first.attempt.attemptSeq).toBe(1);
    expect(second.attempt.attemptSeq).toBe(2);
    expect(second.attempt.attemptId).not.toBe(first.attempt.attemptId);
    // retryOf is lineage, never equivalence: the successor points at the
    // recorded prior attempt; the first attempt has no prior.
    expect(first.attempt.retryOf).toBeNull();
    expect(second.attempt.retryOf).toBe(first.attempt.attemptId);

    const allocationFacts = workFactsOf(item.hash).filter(
      (fact) => fact.type === "work_item.attempt_allocated",
    );
    expect(
      allocationFacts.map((fact) => (JSON.parse(fact.data) as { attemptSeq: number }).attemptSeq),
    ).toEqual([1, 2]);
    // Each allocation fact sits at seq === the revision it projected.
    expect(allocationFacts.map((fact) => fact.seq)).toEqual([
      first.item.revision,
      second.item.revision,
    ]);
    expect(workHeadOf(item.hash)).toBe(second.item.revision);
  });

  test("fail-loud manifest: a category input without a declared reason rejects", () => {
    const categories = WorkItem.NondeterminismCategory.options;
    const covered = {
      recorded: [{ category: "clock", identifier: "ref:clock/system", value: 1_700_000_000_000 }],
      absent: categories
        .filter((category) => category !== "clock")
        .map((category) => ({ category, reason: `${category} input was not consumed` })),
    };
    expect(WorkItem.NondeterminismManifest.safeParse(covered).success).toBe(true);

    const silentlyMissing = {
      ...covered,
      absent: covered.absent.filter((entry) => entry.category !== "random"),
    };
    const rejected = WorkItem.NondeterminismManifest.safeParse(silentlyMissing);
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error.issues.map((issue) => issue.message)).toContain(
        'nondeterminism input "random" is neither recorded nor declared absent with a reason — missing manifest input fails loudly',
      );
    }
  });
});
