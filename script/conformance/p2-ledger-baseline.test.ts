import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Communication,
  LedgerAppend,
  PolicyDecision,
  Wait,
  WorkItem,
} from "../../packages/protocol/src/index";
import {
  createCompletionAdmissionService,
  completionRequestRoot,
} from "../../packages/openomni/src/work-item/completion-admission";
import { DispatchRegistry } from "../../packages/openomni/src/dispatch/registry";
import { CommandRecordError, DispatchRuntime } from "../../packages/openomni/src/dispatch/runtime";
import { registerBuiltInDispatchHandlers } from "../../packages/openomni/src/dispatch/setup";
import { IngressEngine } from "../../packages/openomni/src/ingress/engine";
import { IngressRoutingError } from "../../packages/openomni/src/ingress/routing-execution";
import {
  Bus,
  ChannelGrantStore,
  PendingAskStore,
  Session,
  SqliteStorageAdapter,
  Storage,
  WaitStore,
  WorkerRun,
  WorkerRunStateStore,
  WorkItemStore,
} from "../../packages/session/src/index";
import { Ledger } from "../../packages/session/src/ledger-core/index";
import {
  hasRetryExhaustionBlocker,
  isRetryExhausted,
} from "../../packages/session/src/work-item/retry-policy";
import { waitViewOfPendingAsk } from "../../packages/openomni/src/wait/upcast";
import { buildLedgerArchiveManifest } from "../generate-ledger-archive-manifest";

/**
 * #510 phase B/C1/C2/C3 conformance — the Wait, WorkItem, routing, and
 * dispatch-authorization decision classes against the clean ledger baseline
 * ("no record, no action"):
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
 *       tampered rows;
 *   (f) C3: `route.decided` lands on the single-fact `route:<inboundEventId>`
 *       stream before the routed action's effects are observable — for
 *       terminal (blocked) decisions before the typed rejection returns; a
 *       redelivered inbound id replays the RECORDED decision (accepted
 *       routes re-execute idempotently, terminal decisions repeat their
 *       rejection) with no second fact, while a failing append fails closed
 *       with the action never proceeding;
 *   (g) C3: `command.authorized` lands on `command:<dispatchId>` before the
 *       handler is invoked, `command.denied` before the denial result
 *       returns, and a failing append blocks the dispatch.
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

async function createConformanceWorkItem(
  name: string,
  options: Readonly<{ maxAttempts?: number }> = {},
): Promise<WorkItem.Info> {
  return WorkItemStore.create({
    name,
    sourceMessageId: `msg_${name}`,
    sourceChannel: "conformance",
    intent: "verify",
    goal: "prove no record, no action for the WorkItem class",
    sessionId: "session_conformance",
    acceptanceCriteria: ["the transition is recorded before it acts"],
    ...options,
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

function grantConformanceChannel(): void {
  ChannelGrantStore.put({
    id: "grant-conformance",
    surface: "conformance",
    kind: "trusted_channel",
    defaultTier: "owner",
    createdBy: "act_owner",
  });
}

function routedIngressEvent(id: string, workerSessionId: string) {
  return {
    id,
    surface: "conformance",
    workspace: "team-conformance",
    channel: "C1",
    mode: "direct",
    payload: "prove append-before-act for the route class",
    target: { kind: "worker", sessionId: workerSessionId },
    meta: { actor: { role: "user" } },
    agent: { model: { provider: "test", id: "test-model" } },
  };
}

// Replaces the ledger sub-adapter with one whose connection is gone, keeping
// every projection sub-adapter live — the decision-class append is the ONLY
// thing that fails, so a passing action would prove a record-less act.
function configureFailingLedger(): void {
  const adapter = Storage.getAdapter();
  Storage.configure({
    ...adapter,
    transaction: adapter.transaction.bind(adapter),
    ledger: {
      append: () => {
        throw new Error("ledger connection closed");
      },
      headFact: () => {
        throw new Error("ledger connection closed");
      },
      verifyTail: () => {
        throw new Error("ledger connection closed");
      },
    },
  });
}

describe("p2 ledger baseline — routing decision-class facts (C3)", () => {
  afterEach(() => {
    IngressEngine.clearCoordinator();
    IngressEngine.clearResidentRuntime();
    IngressEngine.clearDispatchRuntime();
  });

  test("route.decided is durable before the routed action's effects are observable", async () => {
    grantConformanceChannel();
    const workerSession = Session.create({
      title: "route conformance",
      model: { providerID: "test", modelID: "test-model" },
    });
    const observed: { factTypes: string[]; parsedOutcome?: string }[] = [];
    IngressEngine.setCoordinator({
      dispatch: async (sessionId, request) => {
        const facts = factsOfStream("route:inbound-route-1");
        const first = facts[0] ? (JSON.parse(facts[0].data) as Record<string, unknown>) : undefined;
        const decided = first === undefined ? undefined : LedgerAppend.RouteDecided.parse(first);
        observed.push({
          factTypes: facts.map((fact) => fact.type),
          ...(decided === undefined ? {} : { parsedOutcome: decided.outcome }),
        });
        return {
          runId: request.runId,
          sessionId,
          status: "succeeded" as const,
          output: "routed",
          finishReason: "stop" as const,
        };
      },
    });

    const result = await IngressEngine.ingest(
      routedIngressEvent("inbound-route-1", workerSession.id),
    );

    // The executor saw the durable route.decided fact BEFORE it acted.
    expect(observed).toEqual([{ factTypes: ["route.decided"], parsedOutcome: "route" }]);
    expect(result.result.output).toBe("routed");
    // Single-fact stream discipline: expectedHead 0, seq 1, head 1.
    const facts = factsOfStream("route:inbound-route-1");
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([[1, "route.decided"]]);
    expect(headOfStream("route:inbound-route-1")).toBe(1);
    // The writer and the protocol stream registry agree on the vocabulary.
    for (const fact of facts) {
      expect(LedgerAppend.StreamRegistry.route.factTypes).toContain(fact.type);
    }
  });

  test("a terminal (blocked) decision lands its fact before the typed rejection returns", async () => {
    // No channel grant for this surface: resolve-route blocks at the channel
    // ceiling. The block is a decision — it must be recorded like a route.
    let thrown: unknown;
    try {
      await IngressEngine.ingest({
        id: "inbound-route-blocked-1",
        surface: "conformance",
        workspace: "team-conformance",
        channel: "C1",
        mode: "direct",
        payload: "blocked inbound",
        meta: { actor: { role: "user" } },
        agent: { model: { provider: "test", id: "test-model" } },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IngressRoutingError);
    expect((thrown as IngressRoutingError).code).toBe("route_blocked");
    const facts = factsOfStream("route:inbound-route-blocked-1");
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([[1, "route.decided"]]);
    const decided = LedgerAppend.RouteDecided.parse(JSON.parse(facts[0]?.data ?? "{}"));
    expect(decided.outcome).toBe("block");
    expect(decided.inboundId).toBe("inbound-route-blocked-1");
  });

  test("a redelivered inbound replays the recorded decision: no second fact, the action re-executes", async () => {
    grantConformanceChannel();
    const workerSession = Session.create({
      title: "route replay conformance",
      model: { providerID: "test", modelID: "test-model" },
    });
    let dispatches = 0;
    IngressEngine.setCoordinator({
      dispatch: async (sessionId, request) => {
        dispatches += 1;
        return {
          runId: request.runId,
          sessionId,
          status: "succeeded" as const,
          output: "routed",
          finishReason: "stop" as const,
        };
      },
    });

    const first = await IngressEngine.ingest(
      routedIngressEvent("inbound-route-replay-1", workerSession.id),
    );
    // Channel redelivery of the SAME inbound (e.g. the delivery crashed after
    // the decision committed): the recorded route.decided fact governs and
    // the routed action re-executes idempotently — the #519 crash-window
    // recovery path, not a refusal.
    const second = await IngressEngine.ingest(
      routedIngressEvent("inbound-route-replay-1", workerSession.id),
    );

    expect(first.result.output).toBe("routed");
    expect(second.result.output).toBe("routed");
    expect(dispatches).toBe(2);
    // Replay appended nothing: the stream still holds exactly the one fact.
    expect(factsOfStream("route:inbound-route-replay-1")).toHaveLength(1);
    expect(headOfStream("route:inbound-route-replay-1")).toBe(1);
  });

  test("a terminal recorded decision replays its own rejection even after conditions change", async () => {
    // First delivery: no channel grant — the block is decided and recorded.
    let firstThrown: unknown;
    try {
      await IngressEngine.ingest({
        id: "inbound-route-replay-blocked-1",
        surface: "conformance",
        workspace: "team-conformance",
        channel: "C1",
        mode: "direct",
        payload: "blocked inbound",
        meta: { actor: { role: "user" } },
        agent: { model: { provider: "test", id: "test-model" } },
      });
    } catch (error) {
      firstThrown = error;
    }
    expect(firstThrown).toBeInstanceOf(IngressRoutingError);
    expect((firstThrown as IngressRoutingError).code).toBe("route_blocked");

    // A grant lands between deliveries: a fresh resolve would now route, but
    // the redelivery replays the RECORDED terminal decision — the same typed
    // rejection it originally produced.
    grantConformanceChannel();
    let secondThrown: unknown;
    try {
      await IngressEngine.ingest({
        id: "inbound-route-replay-blocked-1",
        surface: "conformance",
        workspace: "team-conformance",
        channel: "C1",
        mode: "direct",
        payload: "blocked inbound",
        meta: { actor: { role: "user" } },
        agent: { model: { provider: "test", id: "test-model" } },
      });
    } catch (error) {
      secondThrown = error;
    }

    expect(secondThrown).toBeInstanceOf(IngressRoutingError);
    expect((secondThrown as IngressRoutingError).code).toBe("route_blocked");
    const replayed = (secondThrown as IngressRoutingError).decision;
    expect(replayed.outcome).toBe("block");
    expect(replayed.inboundId).toBe("inbound-route-replay-blocked-1");
    expect(factsOfStream("route:inbound-route-replay-blocked-1")).toHaveLength(1);
  });

  test("a failing ledger append blocks the routed action: typed error, no publish, no act", async () => {
    grantConformanceChannel();
    const workerSession = Session.create({
      title: "route fail-closed conformance",
      model: { providerID: "test", modelID: "test-model" },
    });
    let dispatches = 0;
    IngressEngine.setCoordinator({
      dispatch: async (sessionId, request) => {
        dispatches += 1;
        return {
          runId: request.runId,
          sessionId,
          status: "succeeded" as const,
          output: "routed",
          finishReason: "stop" as const,
        };
      },
    });
    configureFailingLedger();
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    let thrown: unknown;
    try {
      await IngressEngine.ingest(routedIngressEvent("inbound-route-fail-1", workerSession.id));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(IngressRoutingError);
    expect((thrown as IngressRoutingError).code).toBe("route_record_failed");
    expect(dispatches).toBe(0);
    await flushBus();
    // The observe-only RoutingDecision projection fires strictly AFTER the
    // append — a failed append publishes nothing.
    expect(events).not.toContain("ingress.routing.decision");
  });
});

describe("p2 ledger baseline — dispatch authorization decision-class facts (C3)", () => {
  const allowPolicy = {
    kind: "point",
    name: "conformance-allow",
    pointIds: ["dispatch.action.pre"],
    effectCapabilities: { "dispatch.action.pre": [] },
    priority: 0,
    fn: () =>
      PolicyDecision.allow({ policyId: "conformance.allow", reasonCodes: ["conformance_allowed"] }),
  } as const;

  const denyPolicy = {
    kind: "point",
    name: "conformance-deny",
    pointIds: ["dispatch.action.pre"],
    effectCapabilities: { "dispatch.action.pre": [] },
    priority: 0,
    fn: () =>
      PolicyDecision.deny({ policyId: "conformance.deny", reasonCodes: ["conformance_denied"] }),
  } as const;

  test("command.authorized is durable before the handler is invoked", async () => {
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    const observed: { order: string[]; factTypes: string[] }[] = [];
    const order: string[] = [];
    runtime.register("conformance.act", (command) => {
      order.push("handler");
      const facts = factsOfStream(`command:${command.dispatchId}`);
      observed.push({ order: [...order], factTypes: facts.map((fact) => fact.type) });
      return { output: "acted" };
    });

    const result = await runtime.submit(
      { action: "conformance.act", target: { kind: "system" }, payload: "go" },
      { actorKind: "resident", actorId: "resident:main", policies: [allowPolicy] },
    );

    expect(result.status).toBe("completed");
    // The handler ran with the authorization fact already durable.
    expect(observed).toEqual([{ order: ["handler"], factTypes: ["command.authorized"] }]);
    const facts = factsOfStream(`command:${result.dispatchId}`);
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([[1, "command.authorized"]]);
    const authorized = LedgerAppend.CommandAuthorized.parse(JSON.parse(facts[0]?.data ?? "{}"));
    expect(authorized).toEqual({
      verdict: "allow",
      // The dispatch point composes registered policies into one decision;
      // the composed policyId is what the runtime acted on.
      policyId: "agent.policy.composed",
      reason: "conformance_allowed",
      actorKind: "resident",
      action: "conformance.act",
      targetKind: "system",
    });
    expect(headOfStream(`command:${result.dispatchId}`)).toBe(1);
    for (const fact of facts) {
      expect(LedgerAppend.StreamRegistry.command.factTypes).toContain(fact.type);
    }
  });

  test("a denied dispatch lands command.denied before the denial result returns", async () => {
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    let handlerCalls = 0;
    runtime.register("conformance.act", () => {
      handlerCalls += 1;
      return { output: "acted" };
    });

    const result = await runtime.submit(
      { action: "conformance.act", target: { kind: "system" }, payload: "go" },
      { actorKind: "user", actorId: "user:conformance", policies: [denyPolicy] },
    );

    expect(result.status).toBe("denied");
    expect(handlerCalls).toBe(0);
    const facts = factsOfStream(`command:${result.dispatchId}`);
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([[1, "command.denied"]]);
    const denied = LedgerAppend.CommandDenied.parse(JSON.parse(facts[0]?.data ?? "{}"));
    expect(denied).toEqual({
      verdict: "deny",
      policyId: "agent.policy.composed",
      reason: "conformance_denied",
      actorKind: "user",
      action: "conformance.act",
      targetKind: "system",
    });
  });

  test("a failing ledger append blocks the dispatch: typed error, handler never invoked", async () => {
    const runtime = new DispatchRuntime({ includeDefaultPolicies: false });
    let handlerCalls = 0;
    runtime.register("conformance.act", () => {
      handlerCalls += 1;
      return { output: "acted" };
    });
    configureFailingLedger();
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    let thrown: unknown;
    try {
      await runtime.submit(
        { action: "conformance.act", target: { kind: "system" }, payload: "go" },
        { actorKind: "resident", actorId: "resident:main", policies: [allowPolicy] },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CommandRecordError);
    expect((thrown as CommandRecordError).code).toBe("command_record_failed");
    expect(handlerCalls).toBe(0);
    await flushBus();
    // The observe-only Authorized projection fires strictly AFTER the append.
    expect(events).not.toContain("dispatch.authorized");
  });
});

describe("p2 ledger baseline — frozen legacy writers + archive manifest (D2a)", () => {
  function seedFrozenPendingAsk(
    id: string,
    overrides: Partial<Communication.PendingAsk.Record> = {},
  ): Communication.PendingAsk.Record {
    const storage = Storage.getAdapter();
    const adapter = storage.pendingAsk;
    if (!adapter) throw new Error("conformance storage misses the pendingAsk sub-adapter");
    // pending_ask.origin_session_id references session(id).
    storage.session.set("session_conformance", {
      id: "session_conformance",
      title: "session_conformance",
      model: { providerID: "test", modelID: "test-model" },
      time: { created: 1, updated: 1 },
      spawnDepth: 0,
    });
    // Historical rows predate the freeze — seeded at the adapter layer,
    // exactly as pre-freeze rows persist on disk.
    const record = Communication.PendingAsk.Record.parse({
      id,
      originSessionId: "session_conformance",
      originActorKind: "worker",
      targetKind: "external_actor",
      endpointId: "telegram:conformance",
      channelId: "telegram:dm",
      status: "open",
      correlation: { tokenHash: `tok-${id}` },
      createdAt: 100,
      updatedAt: 100,
      ...overrides,
    });
    adapter.create(record);
    return record;
  }

  test("frozen writer: PendingAskStore writes throw the typed frozen error; archived rows stay readable", async () => {
    const record = seedFrozenPendingAsk("ask-frozen");
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    let thrown: unknown;
    try {
      PendingAskStore.answer("ask-frozen", { answeredAt: 5 });
    } catch (error) {
      thrown = error;
    }

    if (!Communication.PendingAsk.FrozenError.isInstance(thrown)) {
      throw new Error("expected the typed PendingAskFrozenError");
    }
    expect(thrown.data.code).toBe("pending_ask_frozen");
    expect(thrown.data.method).toBe("answer");
    await flushBus();
    expect(events).toEqual([]);
    // The frozen row is untouched and still served by every read surface.
    expect(PendingAskStore.get("ask-frozen")?.updatedAt).toBe(record.updatedAt);
    expect(PendingAskStore.findByCorrelation({ tokenHash: "tok-ask-frozen" })).toHaveLength(1);
  });

  test("archive manifest: deterministic range hash over frozen rows in id order; a tampered row mismatches", () => {
    // Insertion order differs from id order on purpose: the manifest hash is
    // defined over canonical row JSON in id order, not arrival order.
    seedFrozenPendingAsk("ask-b");
    seedFrozenPendingAsk("ask-c", { status: "answered", answeredAt: 200 });
    seedFrozenPendingAsk("ask-a", { status: "cancelled" });

    const manifest = buildLedgerArchiveManifest(inspect);
    expect(manifest.manifestVersion).toBe(1);
    const entry = manifest.tables.find((table) => table.table === "pending_ask");
    if (!entry) throw new Error("manifest misses the frozen pending_ask table");
    expect(entry).toMatchObject({
      table: "pending_ask",
      sourceSchemaVersion: "0014_work_item_revision/migration.sql",
      rowCount: 3,
      idRange: { first: "ask-a", last: "ask-c" },
    });
    expect(entry.integrityHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Regenerating over the same rows reproduces the hash byte-for-byte.
    const regenerated = buildLedgerArchiveManifest(inspect).tables.find(
      (table) => table.table === "pending_ask",
    );
    expect(regenerated?.integrityHash).toBe(entry.integrityHash);

    // A tampered archived row breaks the range hash.
    inspect.query("UPDATE pending_ask SET status = 'answered' WHERE id = 'ask-b'").run();
    const tampered = buildLedgerArchiveManifest(inspect).tables.find(
      (table) => table.table === "pending_ask",
    );
    expect(tampered?.integrityHash).not.toBe(entry.integrityHash);
    expect(tampered?.rowCount).toBe(3);
  });

  test("upcast-on-read is deterministic and never materializes archive rows as active rows", () => {
    const record = seedFrozenPendingAsk("ask-upcast", { status: "ambiguous" });

    const first = waitViewOfPendingAsk(record);
    const reread = PendingAskStore.get("ask-upcast");
    if (!reread) throw new Error("frozen row must stay readable");
    const second = waitViewOfPendingAsk(reread);

    // Deterministic: the same archived row always upcasts to the same view.
    expect(second).toEqual(first);
    // Legacy "ambiguous" stays answerable through the Wait vocabulary.
    expect(first.status).toBe("open");
    expect(first.revision).toBe(0);

    // The read wrote nothing: no active wait row appeared and the archived
    // row's stored bytes are unchanged.
    expect(inspect.query("SELECT COUNT(*) AS n FROM wait").get()).toEqual({ n: 0 });
    expect(
      inspect.query("SELECT data, time_updated FROM pending_ask WHERE id = 'ask-upcast'").get(),
    ).toEqual({ data: JSON.stringify(record), time_updated: 100 });
  });

  test("retry-policy reads the fact-bound WorkItem projection: retry and exhaustion decisions are recorded facts", async () => {
    const item = await createConformanceWorkItem("retry-policy-receipt", { maxAttempts: 2 });
    await WorkItemStore.start(item.hash);
    await WorkItemStore.fail(item.hash, "first failure");

    const retried = await WorkItemStore.retry(item.hash);
    if (!retried) throw new Error("retry must return the updated projection");

    // The attempt count retry-policy evaluates is carried by the head fact
    // at seq === revision — the projection is the fold of the work: stream,
    // never a WorkerRun read.
    const facts = workFactsOf(item.hash);
    const retriedFact = facts.at(-1);
    expect(retriedFact?.type).toBe("work_item.retried");
    expect(JSON.parse(retriedFact?.data ?? "{}")).toMatchObject({
      attempt: retried.attempt,
      revision: retried.revision,
    });
    expect(workHeadOf(item.hash)).toBe(retried.revision);
    expect(retried.attempt).toBe(2);
    expect(isRetryExhausted(retried)).toBe(true);

    // Exhaustion is itself a recorded decision: the blocker fact lands
    // before the typed throw, and the projection the policy reads agrees.
    await WorkItemStore.fail(item.hash, "second failure");
    let thrown: unknown;
    try {
      await WorkItemStore.retry(item.hash);
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain("retry attempts exhausted");
    expect(workFactsOf(item.hash).at(-1)?.type).toBe("work_item.blocker_added");
    const exhausted = WorkItemStore.get(item.hash);
    if (!exhausted) throw new Error("exhausted projection must exist");
    expect(hasRetryExhaustionBlocker(exhausted)).toBe(true);
  });
});
