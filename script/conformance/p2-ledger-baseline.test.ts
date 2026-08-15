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
  WorkerRun as WorkerRunProtocol,
  WorkItem,
} from "../../packages/protocol/src/index";
import {
  createCompletionAdmissionService,
  completionRequestRoot,
} from "../../packages/openomni/src/work-item/completion-admission";
import { DispatchRegistry } from "../../packages/openomni/src/dispatch/registry";
import { CommandRecordError, DispatchRuntime } from "../../packages/openomni/src/dispatch/runtime";
import { registerBuiltInDispatchHandlers } from "../../packages/openomni/src/dispatch/setup";
import { createIngressEngine } from "../../packages/openomni/src/ingress/engine";
import { IngressRoutingError } from "../../packages/openomni/src/ingress/routing-resolution";
import {
  Bus,
  ChannelGrantStore,
  PendingAskStore,
  PendingInteractionStore,
  Session,
  SqliteStorageAdapter,
  Storage,
  WaitStore,
  WorkerRunStateStore,
  WorkItemAttemptRun,
  WorkItemStore,
} from "../../packages/session/src/index";
import { Ledger } from "../../packages/session/src/ledger-core/index";
import {
  hasRetryExhaustionBlocker,
  isRetryExhausted,
} from "../../packages/session/src/work-item/retry-policy";
import {
  waitViewOfPendingAsk,
  waitViewOfPendingInteraction,
} from "../../packages/openomni/src/wait/upcast";
import {
  buildReplyInput,
  buildWaitCreate as buildSessionWaitCreate,
  captureStoreError,
} from "../../packages/session/test/helpers/wait";
import { EffectService } from "../../packages/openomni/src/effect/lifecycle";
import { EffectManifest } from "../../packages/openomni/src/effect/manifest";
import { runRecovery } from "../../apps/server/src/bootstrap/recovery";
import { buildLedgerArchiveManifest } from "../generate-ledger-archive-manifest";
import {
  LEDGER_PRODUCER_MANIFEST,
  matchesFrozenTableWriteSql,
  matchesLedgerTableWriteSql,
  matchesLedgerWriteCall,
  matchesMigrationTableWriteSql,
  scanLedgerProducers,
} from "../ledger-producer-manifest";

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
 *   (f) C3: `route.decided` lands on the single-fact channel-scoped stream
 *       `route:<surface>:<workspace>:<channel>:<inboundEventId>` before the
 *       routed action's effects are observable — for terminal (blocked)
 *       decisions before the typed rejection returns; replay is
 *       EQUIVALENCE-GATED (review fix F2): a redelivered inbound proceeds
 *       with its FRESH resolution only when the fresh decision matches the
 *       recorded one (accepted routes re-execute idempotently, terminal
 *       decisions repeat their rejection — no second fact), a divergent
 *       redelivery fails closed as route_replay_divergent with no action,
 *       and a failing append fails closed with the action never proceeding;
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
// The REAL adapter behind any test-local Storage.configure swap (e.g.
// configureFailingLedger spreads it into a plain object, losing the
// prototype's close()): afterEach closes THIS, not whatever getAdapter()
// returns, so the primary + telemetry connections never leak.
let baseAdapter: SqliteStorageAdapter | undefined;

beforeEach(() => {
  Bus.reset();
  Storage.reset();
  tempDir = mkdtempSync(join(tmpdir(), "p2-ledger-baseline-"));
  Storage.initialize({ dbPath: join(tempDir, "openomni.db") });
  const adapter = Storage.getAdapter();
  baseAdapter = adapter instanceof SqliteStorageAdapter ? adapter : undefined;
  // Second connection on the same WAL file: assertions and tampering must
  // not ride the writer's connection.
  inspect = new Database(join(tempDir, "openomni.db"));
});

afterEach(() => {
  inspect.close();
  baseAdapter?.close();
  baseAdapter = undefined;
  Storage.reset();
  Bus.reset();
  rmSync(tempDir, { recursive: true, force: true });
});

const flushBus = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()));

// Fixture dedup (review fix minor): the session test helper owns the base
// Wait fixture shape; this wrapper only pins the conformance defaults
// (single-responder first_reply wait owned by workItem wi-1).
function buildWaitCreate(overrides: Partial<Wait.Create> = {}): Wait.Create {
  return buildSessionWaitCreate({
    ownerRef: { kind: "workItem", id: "wi-1" },
    correlation: { tokenHash: "tok-1" },
    allowedActions: ["report_result"],
    expectedResponders: ["actor-a"],
    resolutionPolicy: "first_reply",
    quorum: undefined,
    ...overrides,
  });
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

  test("a pre-cutover wait row (revision >= 1, empty stream) is adopted lazily before its first transition", () => {
    WaitStore.create(buildWaitCreate());
    // Simulate an old-DB wait: the projection row exists at revision >= 1
    // but its owner stream is empty (every write predates the phase-B
    // cutover). Without adoption this row would brick every transition
    // (append at expectedHead 1 against head 0 = permanent conflict).
    inspect.query("DELETE FROM ledger_event WHERE stream_id = ?").run("wait:wait-1");
    inspect.query("DELETE FROM ledger_head WHERE stream_id = ?").run("wait:wait-1");
    expect(factsOf("wait-1")).toHaveLength(0);

    const outcome = WaitStore.attachReply("wait-1", buildReplyInput());

    expect(outcome.kind).toBe("resolved");
    const facts = factsOf("wait-1");
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([
      [1, "wait.adopted"],
      [2, "wait.resolved"],
    ]);
    expect(headOf("wait-1")).toBe(2);
    expect(WaitStore.get("wait-1")?.revision).toBe(2);
    const adopted = JSON.parse(facts[0]?.data ?? "{}") as {
      ownerKind?: string;
      ownerId?: string;
      status?: string;
      revision?: number;
    };
    // The genesis fact records the observed identity at seq === revision —
    // pre-cutover history is adopted, never fabricated — and carries NO
    // erasable data: the hash-chained fact is immutable, so replies
    // (responder ids) and correlation identifiers must never bake into it.
    expect(adopted.revision).toBe(1);
    expect(adopted.ownerKind).toBe("workItem");
    expect(adopted.ownerId).toBe("wi-1");
    expect(adopted.status).toBe("open");
    expect(adopted).not.toHaveProperty("snapshot");
    expect(adopted).not.toHaveProperty("replies");
    expect(adopted).not.toHaveProperty("correlation");
    // The adopted stream verifies clean at boot.
    expect(Ledger.verifyTail(inspect)).toEqual([]);
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

  test("a pre-cutover row is adopted lazily at ITS revision: genesis fact carries the observed snapshot", async () => {
    const item = await createConformanceWorkItem("lazy-adoption");
    const started = await WorkItemStore.start(item.hash);
    if (started?.revision !== 2) throw new Error("expected revision 2 after start");
    // Simulate a migration-shifted pre-cutover row: 0014 backfills every
    // existing row to old json revision + 1, so a row with prior transitions
    // sits at revision > 1 with an EMPTY owner stream. Adoption must land at
    // the row's OWN revision, not at 1 (review fix F4).
    inspect.query("DELETE FROM ledger_event WHERE stream_id = ?").run(`work:${item.hash}`);
    inspect.query("DELETE FROM ledger_head WHERE stream_id = ?").run(`work:${item.hash}`);
    expect(workFactsOf(item.hash)).toHaveLength(0);

    const failed = await WorkItemStore.fail(item.hash, "post-adoption transition");

    expect(failed?.revision).toBe(3);
    const facts = workFactsOf(item.hash);
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([
      [2, "work_item.adopted"],
      [3, "work_item.failed"],
    ]);
    expect(workHeadOf(item.hash)).toBe(3);
    const adopted = JSON.parse(facts[0]?.data ?? "{}") as {
      snapshot?: { hash?: string; revision?: number };
      revision?: number;
    };
    // The genesis fact records the observed state at seq === revision —
    // pre-cutover history is adopted, never fabricated.
    expect(adopted.revision).toBe(2);
    expect(adopted.snapshot?.hash).toBe(item.hash);
    expect(adopted.snapshot?.revision).toBe(2);
    // The adopted stream verifies clean at boot.
    expect(Ledger.verifyTail(inspect)).toEqual([]);
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
      upstreamFingerprints: {
        absent: true,
        reason: "no upstream attempts in the conformance suite",
      },
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
  test("worker.spawn appends work_item.attempt_allocated before the executor acts — no WorkerRun rows", async () => {
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
            // The executor acts only now — strictly AFTER the appended
            // attempt fact. #510 D2b: the run lifecycle IS the attempt
            // facts; no worker_run_state row is ever written.
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
    // #510 D2b: the frozen worker_run_state table gains no row — the
    // execution instance lives entirely on the work stream.
    expect(WorkerRunStateStore.get(result.output.sessionId, result.output.runId)).toBeUndefined();
    expect(factsOfStream(`work:${result.output.workItemHash}`).map((fact) => fact.type)).toContain(
      "work_item.attempt_finished",
    );
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

  test("a cache hit creates a NEW attempt recording reusedFromAttemptId — never a row reuse", async () => {
    const item = await createConformanceWorkItem("cache-hit-new-attempt");
    const seeded = await WorkItemStore.allocateAttempt(
      item.hash,
      conformanceAttemptIdentity("cache seed"),
    );
    if (!seeded) throw new Error("expected the seeding allocation");

    // A cacheKey hit is an EXPLICIT lookup that allocates a fresh attempt
    // and records the reused one — cache/replay EXECUTION (lookup, JSONL
    // export) is #493; the identity contract is #510's.
    const hit = await WorkItemStore.allocateAttempt(item.hash, {
      ...conformanceAttemptIdentity("cache seed"),
      reusedFromAttemptId: seeded.attempt.attemptId,
    });
    if (!hit) throw new Error("expected the cache-hit allocation");

    expect(hit.attempt.attemptId).not.toBe(seeded.attempt.attemptId);
    expect(hit.attempt.attemptSeq).toBe(seeded.attempt.attemptSeq + 1);
    expect(hit.attempt.reusedFromAttemptId).toBe(seeded.attempt.attemptId);
    expect(seeded.attempt.reusedFromAttemptId).toBeNull();

    // Both allocations are separate durable facts; the seeded fact is
    // untouched by the hit (immutable reuse rejects rewrites).
    const allocationFacts = workFactsOf(item.hash).filter(
      (fact) => fact.type === "work_item.attempt_allocated",
    );
    expect(allocationFacts).toHaveLength(2);
    const recorded = allocationFacts.map(
      (fact) => JSON.parse(fact.data) as { attemptId: string; reusedFromAttemptId: string | null },
    );
    expect(recorded[0]).toMatchObject({
      attemptId: seeded.attempt.attemptId,
      reusedFromAttemptId: null,
    });
    expect(recorded[1]).toMatchObject({
      attemptId: hit.attempt.attemptId,
      reusedFromAttemptId: seeded.attempt.attemptId,
    });

    // The identity schema refuses a self-referential reuse loudly.
    expect(
      WorkItem.Attempt.safeParse({
        ...hit.attempt,
        reusedFromAttemptId: hit.attempt.attemptId,
      }).success,
    ).toBe(false);
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
    traceId: "trace-test",
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

// Review fix F1: the route owner stream is channel-scoped — normalizer ids
// are only unique within a channel, so surface + workspace + channel are
// part of the stream identity.
function routeStreamOf(inboundId: string): string {
  return `route:conformance:team-conformance:C1:${inboundId}`;
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
      adoptStream: () => {
        throw new Error("ledger connection closed");
      },
      headFact: () => {
        throw new Error("ledger connection closed");
      },
      factsByType: () => {
        throw new Error("ledger connection closed");
      },
      verifyTail: () => {
        throw new Error("ledger connection closed");
      },
    },
  });
}

describe("p2 ledger baseline — routing decision-class facts (C3)", () => {
  // #549: the engine is an instance — each scenario constructs its own with
  // explicit deps instead of mutating module-global setters.
  test("route.decided is durable before the routed action's effects are observable", async () => {
    grantConformanceChannel();
    const workerSession = Session.create({
      title: "route conformance",
      model: { providerID: "test", modelID: "test-model" },
    });
    const observed: { factTypes: string[]; parsedOutcome?: string }[] = [];
    const engine = createIngressEngine({
      coordinator: {
        dispatch: async (sessionId, request) => {
          const facts = factsOfStream(routeStreamOf("inbound-route-1"));
          const first = facts[0]
            ? (JSON.parse(facts[0].data) as Record<string, unknown>)
            : undefined;
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
      },
    });

    const result = await engine.ingest(routedIngressEvent("inbound-route-1", workerSession.id));

    // The executor saw the durable route.decided fact BEFORE it acted.
    expect(observed).toEqual([{ factTypes: ["route.decided"], parsedOutcome: "route" }]);
    expect(result.result.output).toBe("routed");
    // Single-fact stream discipline: expectedHead 0, seq 1, head 1, on the
    // channel-scoped stream key (review fix F1).
    const facts = factsOfStream(routeStreamOf("inbound-route-1"));
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([[1, "route.decided"]]);
    expect(headOfStream(routeStreamOf("inbound-route-1"))).toBe(1);
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
      await createIngressEngine().ingest({
        id: "inbound-route-blocked-1",
        traceId: "trace-test",
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
    const facts = factsOfStream(routeStreamOf("inbound-route-blocked-1"));
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([[1, "route.decided"]]);
    const decided = LedgerAppend.RouteDecided.parse(JSON.parse(facts[0]?.data ?? "{}"));
    expect(decided.outcome).toBe("block");
    expect(decided.inboundId).toBe("inbound-route-blocked-1");
  });

  test("an equivalent redelivered inbound replays: no second fact, the owner re-receives the action", async () => {
    grantConformanceChannel();
    const workerSession = Session.create({
      title: "route replay conformance",
      model: { providerID: "test", modelID: "test-model" },
    });
    let dispatches = 0;
    const dispatchedSessions: string[] = [];
    const engine = createIngressEngine({
      coordinator: {
        dispatch: async (sessionId, request) => {
          dispatches += 1;
          dispatchedSessions.push(sessionId);
          return {
            runId: request.runId,
            sessionId,
            status: "succeeded" as const,
            output: "routed",
            finishReason: "stop" as const,
          };
        },
      },
    });

    const first = await engine.ingest(
      routedIngressEvent("inbound-route-replay-1", workerSession.id),
    );
    // Channel redelivery of the SAME inbound (e.g. the delivery crashed
    // after the decision committed): the fresh decision matches the recorded
    // one, so the equivalence gate lets the redelivery proceed with its
    // FRESH resolution and the owner receives the action again — the #519
    // crash-window recovery path, not a refusal (review fix F2).
    const second = await engine.ingest(
      routedIngressEvent("inbound-route-replay-1", workerSession.id),
    );

    expect(first.result.output).toBe("routed");
    expect(second.result.output).toBe("routed");
    expect(dispatches).toBe(2);
    expect(dispatchedSessions).toEqual([workerSession.id, workerSession.id]);
    // Replay appended nothing: the stream still holds exactly the one fact.
    expect(factsOfStream(routeStreamOf("inbound-route-replay-1"))).toHaveLength(1);
    expect(headOfStream(routeStreamOf("inbound-route-replay-1"))).toBe(1);
  });

  test("a divergent redelivery fails closed as route_replay_divergent: no action, no second fact", async () => {
    // First delivery: no channel grant — the block is decided and recorded.
    let firstThrown: unknown;
    try {
      await createIngressEngine().ingest({
        id: "inbound-route-replay-divergent-1",
        traceId: "trace-test",
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

    // A grant lands between deliveries: the fresh resolve now ROUTES while
    // the recorded decision BLOCKED — the equivalence gate refuses to mix a
    // recorded decision with a fresh resolution (review fix F2): typed
    // route_replay_divergent, no execution, no second fact, nothing new
    // published.
    grantConformanceChannel();
    const workerSession = Session.create({
      title: "route divergent replay conformance",
      model: { providerID: "test", modelID: "test-model" },
    });
    let dispatches = 0;
    const engine = createIngressEngine({
      coordinator: {
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
      },
    });
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    let secondThrown: unknown;
    try {
      await engine.ingest(routedIngressEvent("inbound-route-replay-divergent-1", workerSession.id));
    } catch (error) {
      secondThrown = error;
    }

    expect(secondThrown).toBeInstanceOf(IngressRoutingError);
    expect((secondThrown as IngressRoutingError).code).toBe("route_replay_divergent");
    expect(dispatches).toBe(0);
    expect(factsOfStream(routeStreamOf("inbound-route-replay-divergent-1"))).toHaveLength(1);
    await flushBus();
    // The divergent replay published no new RoutingDecision projection.
    expect(events).not.toContain("ingress.routing.decision");
  });

  test("a terminal-equivalent redelivery repeats its recorded rejection with no second fact", async () => {
    // No channel grant on EITHER delivery: the fresh decision on redelivery
    // is the same block the recorded fact holds — equivalent, so the same
    // typed rejection repeats (the terminal analogue of the accepted-route
    // replay).
    const blockedEvent = () => ({
      id: "inbound-route-replay-blocked-1",
      traceId: "trace-test",
      surface: "conformance",
      workspace: "team-conformance",
      channel: "C1",
      mode: "direct",
      payload: "blocked inbound",
      meta: { actor: { role: "user" } },
      agent: { model: { provider: "test", id: "test-model" } },
    });
    const engine = createIngressEngine();
    let firstThrown: unknown;
    try {
      await engine.ingest(blockedEvent());
    } catch (error) {
      firstThrown = error;
    }
    expect(firstThrown).toBeInstanceOf(IngressRoutingError);
    expect((firstThrown as IngressRoutingError).code).toBe("route_blocked");

    let secondThrown: unknown;
    try {
      await engine.ingest(blockedEvent());
    } catch (error) {
      secondThrown = error;
    }

    expect(secondThrown).toBeInstanceOf(IngressRoutingError);
    expect((secondThrown as IngressRoutingError).code).toBe("route_blocked");
    const replayed = (secondThrown as IngressRoutingError).decision;
    expect(replayed.outcome).toBe("block");
    expect(replayed.inboundId).toBe("inbound-route-replay-blocked-1");
    expect(factsOfStream(routeStreamOf("inbound-route-replay-blocked-1"))).toHaveLength(1);
  });

  test("a failing ledger append blocks the routed action: typed error, no publish, no act", async () => {
    grantConformanceChannel();
    const workerSession = Session.create({
      title: "route fail-closed conformance",
      model: { providerID: "test", modelID: "test-model" },
    });
    let dispatches = 0;
    const engine = createIngressEngine({
      coordinator: {
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
      },
    });
    configureFailingLedger();
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    let thrown: unknown;
    try {
      await engine.ingest(routedIngressEvent("inbound-route-fail-1", workerSession.id));
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
      {
        traceId: "trace-conformance",
        actorKind: "resident",
        actorId: "resident:main",
        policies: [allowPolicy],
      },
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
      {
        traceId: "trace-conformance",
        actorKind: "user",
        actorId: "user:conformance",
        policies: [denyPolicy],
      },
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
        {
          traceId: "trace-conformance",
          actorKind: "resident",
          actorId: "resident:main",
          policies: [allowPolicy],
        },
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
      sourceSchemaVersion: "0015_transcript_fact/migration.sql",
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

  // PendingInteractionStore writes are frozen (#548) — historical rows are
  // seeded at the adapter layer, exactly as pre-freeze rows persist on disk.
  async function seedFrozenPendingInteraction(
    id: string,
    overrides: Partial<Communication.PendingInteraction.Record> = {},
  ): Promise<Communication.PendingInteraction.Record> {
    const adapter = Storage.getAdapter().pendingInteraction;
    if (!adapter) throw new Error("conformance storage misses the pendingInteraction sub-adapter");
    const session = Session.create({
      title: `pi-conformance-${id}`,
      model: { providerID: "test", modelID: "test-model" },
    });
    // The worker-run store is frozen (#510 D2b) — the FK row is seeded at
    // the adapter layer, exactly as pre-freeze rows persist on disk.
    const workerRunAdapter = Storage.getAdapter().workerRunState;
    if (!workerRunAdapter) throw new Error("workerRunState sub-adapter missing");
    workerRunAdapter.create(session.id, {
      runId: `run-${id}`,
      agentName: "worker",
      status: "queued",
      executorKind: "internal_chat_agent",
      title: id,
      prompt: "test",
    });
    const record = Communication.PendingInteraction.Record.parse({
      id,
      workerRunId: `run-${id}`,
      sessionId: session.id,
      endpointId: "telegram:conformance",
      channelId: "telegram:dm",
      correlation: { tokenHash: `tok-${id}` },
      allowedActions: ["report_result"],
      status: "open",
      createdAt: 100,
      updatedAt: 100,
      expiresAt: 9_999_999_999_999,
      followUpWindow: 100,
      ...overrides,
    });
    adapter.create(record);
    return record;
  }

  test("frozen writer (#548): PendingInteractionStore writes throw the typed frozen error; archived rows stay readable", async () => {
    const record = await seedFrozenPendingInteraction("pi-frozen");
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    let thrown: unknown;
    try {
      PendingInteractionStore.resolve("pi-frozen", { resolvedAt: 5 });
    } catch (error) {
      thrown = error;
    }

    if (!Communication.PendingInteraction.FrozenError.isInstance(thrown)) {
      throw new Error("expected the typed PendingInteractionFrozenError");
    }
    expect(thrown.data.code).toBe("pending_interaction_frozen");
    expect(thrown.data.method).toBe("resolve");
    await flushBus();
    expect(events).toEqual([]);
    // The frozen row is untouched and still served by every read surface.
    expect(PendingInteractionStore.get("pi-frozen")?.updatedAt).toBe(record.updatedAt);
    expect(
      PendingInteractionStore.findByCorrelation({
        endpointId: "telegram:conformance",
        channelId: "telegram:dm",
        tokenHash: "tok-pi-frozen",
      }),
    ).toHaveLength(1);
  });

  test("archive manifest covers frozen pending_interaction rows: deterministic range hash, tamper mismatch", async () => {
    await seedFrozenPendingInteraction("pi-b");
    await seedFrozenPendingInteraction("pi-c", { status: "resolved", resolvedAt: 200 });
    await seedFrozenPendingInteraction("pi-a", { status: "cancelled", cancelledAt: 150 });

    const manifest = buildLedgerArchiveManifest(inspect);
    const entry = manifest.tables.find((table) => table.table === "pending_interaction");
    if (!entry) throw new Error("manifest misses the frozen pending_interaction table");
    expect(entry).toMatchObject({
      table: "pending_interaction",
      rowCount: 3,
      idRange: { first: "pi-a", last: "pi-c" },
    });
    expect(entry.integrityHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Regenerating over the same rows reproduces the hash byte-for-byte.
    const regenerated = buildLedgerArchiveManifest(inspect).tables.find(
      (table) => table.table === "pending_interaction",
    );
    expect(regenerated?.integrityHash).toBe(entry.integrityHash);

    // A tampered archived row breaks the range hash.
    inspect.query("UPDATE pending_interaction SET status = 'resolved' WHERE id = 'pi-b'").run();
    const tampered = buildLedgerArchiveManifest(inspect).tables.find(
      (table) => table.table === "pending_interaction",
    );
    expect(tampered?.integrityHash).not.toBe(entry.integrityHash);
    expect(tampered?.rowCount).toBe(3);
  });

  test("pending_interaction upcast-on-read is deterministic and never materializes archive rows", async () => {
    const record = await seedFrozenPendingInteraction("pi-upcast", {
      status: "follow_up",
      resolvedAt: 120,
    });

    const first = waitViewOfPendingInteraction(record);
    const reread = PendingInteractionStore.get("pi-upcast");
    if (!reread) throw new Error("frozen row must stay readable");
    const second = waitViewOfPendingInteraction(reread);

    // Deterministic: the same archived row always upcasts to the same view.
    expect(second).toEqual(first);
    // Legacy "follow_up" folds to resolved in the Wait vocabulary.
    expect(first.status).toBe("resolved");
    expect(first.revision).toBe(0);

    // The read wrote nothing: no active wait row appeared and the archived
    // row's stored bytes are unchanged.
    expect(inspect.query("SELECT COUNT(*) AS n FROM wait").get()).toEqual({ n: 0 });
    expect(
      inspect
        .query("SELECT data, time_updated FROM pending_interaction WHERE id = 'pi-upcast'")
        .get(),
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

describe("p2 ledger baseline — frozen worker-run writer + archive manifest (D2b)", () => {
  // WorkerRun writes are frozen (#510 D2b) — historical rows are seeded at
  // the adapter layer, exactly as pre-freeze rows persist on disk.
  function seedFrozenWorkerRun(
    runId: string,
    status: WorkerRunProtocol.Status,
    sessionId = "session_conformance_wr",
  ): void {
    const storage = Storage.getAdapter();
    if (!storage.session.get(sessionId)) {
      storage.session.set(sessionId, {
        id: sessionId,
        title: sessionId,
        model: { providerID: "test", modelID: "test-model" },
        time: { created: 1, updated: 1 },
        spawnDepth: 0,
      });
    }
    const adapter = storage.workerRunState;
    if (!adapter) throw new Error("conformance storage misses the workerRunState sub-adapter");
    adapter.create(sessionId, {
      runId,
      parentSessionId: "resident-session",
      agentName: "worker",
      status,
      executorKind: "internal_chat_agent",
      title: runId,
      prompt: "archived work",
      timeCreated: 100,
      timeUpdated: 100,
    });
  }

  test("frozen writer (D2b): worker-run writes throw the typed frozen error; archived rows stay readable", async () => {
    seedFrozenWorkerRun("run-frozen-conformance", "running");
    const events: string[] = [];
    Bus.observe((event) => events.push(event.name));

    let thrown: unknown;
    try {
      WorkerRunStateStore.updateStatus(
        "session_conformance_wr",
        "run-frozen-conformance",
        "succeeded",
      );
    } catch (error) {
      thrown = error;
    }

    if (!WorkerRunProtocol.FrozenError.isInstance(thrown)) {
      throw new Error("expected the typed WorkerRunFrozenError");
    }
    expect(thrown.data.code).toBe("worker_run_frozen");
    expect(thrown.data.method).toBe("updateStatus");
    await flushBus();
    expect(events).toEqual([]);
    // The frozen row is untouched and still served by every read surface.
    expect(
      WorkerRunStateStore.get("session_conformance_wr", "run-frozen-conformance")?.status,
    ).toBe("running");
    expect(WorkerRunStateStore.listBySession("session_conformance_wr")).toHaveLength(1);
  });

  test("archive manifest covers frozen worker_run_state rows: deterministic range hash, tamper mismatch", async () => {
    seedFrozenWorkerRun("run-wr-b", "succeeded");
    seedFrozenWorkerRun("run-wr-c", "failed");
    seedFrozenWorkerRun("run-wr-a", "waiting_input");

    const manifest = buildLedgerArchiveManifest(inspect);
    const entry = manifest.tables.find((table) => table.table === "worker_run_state");
    if (!entry) throw new Error("manifest misses the frozen worker_run_state table");
    expect(entry).toMatchObject({
      table: "worker_run_state",
      rowCount: 3,
      idRange: { first: "run-wr-a", last: "run-wr-c" },
    });
    expect(entry.integrityHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Regenerating over the same rows reproduces the hash byte-for-byte.
    const regenerated = buildLedgerArchiveManifest(inspect).tables.find(
      (table) => table.table === "worker_run_state",
    );
    expect(regenerated?.integrityHash).toBe(entry.integrityHash);

    // A tampered archived row breaks the range hash.
    inspect
      .query("UPDATE worker_run_state SET status = 'succeeded' WHERE run_id = 'run-wr-a'")
      .run();
    const tampered = buildLedgerArchiveManifest(inspect).tables.find(
      (table) => table.table === "worker_run_state",
    );
    expect(tampered?.integrityHash).not.toBe(entry.integrityHash);
    expect(tampered?.rowCount).toBe(3);
  });

  test("worker_run upcast-on-read is deterministic and never materializes archive rows", async () => {
    seedFrozenWorkerRun("run-upcast-done", "succeeded");
    seedFrozenWorkerRun("run-upcast-live", "running");

    // Terminal statuses map 1:1 through the attempt-run view.
    const done = WorkItemAttemptRun.find("session_conformance_wr", "run-upcast-done");
    expect(done).toMatchObject({
      status: "succeeded",
      parentSessionId: "resident-session",
      source: "worker_run_upcast",
    });

    // A non-terminal legacy status folds to interrupted: no live process
    // can be executing a pre-freeze run.
    const first = WorkItemAttemptRun.find("session_conformance_wr", "run-upcast-live");
    expect(first?.status).toBe("interrupted");
    const second = WorkItemAttemptRun.find("session_conformance_wr", "run-upcast-live");
    expect(second).toEqual(first);

    // The read wrote nothing: no WorkItem row appeared, no attempt fact was
    // appended, and the archived row's stored bytes are unchanged.
    expect(inspect.query("SELECT COUNT(*) AS n FROM work_item").get()).toEqual({ n: 0 });
    expect(
      inspect
        .query("SELECT COUNT(*) AS n FROM ledger_event WHERE type LIKE 'work_item.attempt%'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      inspect
        .query("SELECT status, time_updated FROM worker_run_state WHERE run_id = 'run-upcast-live'")
        .get(),
    ).toEqual({ status: "running", time_updated: 100 });
    // And nothing frozen can be re-animated through the attempt surfaces.
    expect(await WorkItemAttemptRun.beginWait("session_conformance_wr", "run-upcast-live")).toBe(
      false,
    );
    expect(WorkItemAttemptRun.listActive("session_conformance_wr")).toEqual([]);
  });
});

describe("p2 ledger baseline — effect decision-class facts (intent/outcome)", () => {
  function manifestWithDriver(driver: {
    kind: string;
    execute: (
      intent: unknown,
      input: unknown,
    ) =>
      | Promise<{ kind: "confirmed"; receipt?: string } | { kind: "failed"; reason: string }>
      | { kind: "confirmed"; receipt?: string }
      | { kind: "failed"; reason: string };
  }): EffectManifest {
    const manifest = new EffectManifest();
    manifest.register({
      kind: driver.kind,
      execute: driver.execute,
      reconcile: () => ({ kind: "unknown" }),
    });
    return manifest;
  }

  test("a failing intent append fails closed: typed error, the driver never executes, zero facts", async () => {
    const executions: unknown[] = [];
    const service = new EffectService(
      manifestWithDriver({
        kind: "conformance.noop",
        execute: (intent) => {
          executions.push(intent);
          return { kind: "confirmed" };
        },
      }),
    );
    configureFailingLedger();

    let thrown: unknown;
    try {
      await service.run({ effectId: "eff-fail-closed", kind: "conformance.noop" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(executions).toEqual([]);
    // No record, no action — and no half-record either.
    expect(factsOfStream("effect:eff-fail-closed")).toEqual([]);
    expect(headOfStream("effect:eff-fail-closed")).toBeUndefined();
  });

  test("the act happens only after the FULL intent append; exactly one terminal outcome fact follows", async () => {
    const observed: { factTypes: [number, string][] }[] = [];
    const service = new EffectService(
      manifestWithDriver({
        kind: "conformance.noop",
        execute: () => {
          // The driver is the act: at act time the intent is already durable.
          observed.push({
            factTypes: factsOfStream("effect:eff-happy").map((fact) => [fact.seq, fact.type]),
          });
          return { kind: "confirmed", receipt: "receipt-1" };
        },
      }),
    );

    const result = await service.run({ effectId: "eff-happy", kind: "conformance.noop" });

    expect(observed).toEqual([{ factTypes: [[1, "effect.intended"]] }]);
    expect(result.runtime).toBe("confirmed");
    expect(factsOfStream("effect:eff-happy").map((fact) => [fact.seq, fact.type])).toEqual([
      [1, "effect.intended"],
      [2, "effect.confirmed"],
    ]);
    // The writer and the protocol stream registry agree on the vocabulary.
    for (const fact of factsOfStream("effect:eff-happy")) {
      expect(LedgerAppend.StreamRegistry.effect.factTypes).toContain(fact.type);
    }
  });
});

describe("p2 ledger baseline — telemetry and Bus.publish cannot authorize", () => {
  test("a lossy Bus.publish (crashing subscriber) neither prevents the durable fact from folding nor rolls it back", async () => {
    const item = await createConformanceWorkItem("lossy-bus");
    const headsAtDelivery: (number | undefined)[] = [];
    Bus.subscribe(WorkItem.Events.StatusChanged, () => {
      // The observe-only projection: record what is ALREADY durable at
      // delivery time, then crash. Publish is lossy by contract — the
      // crash must not unwind the committed decision.
      headsAtDelivery.push(workHeadOf(item.hash));
      throw new Error("subscriber crashed — publish is lossy");
    });

    const started = await WorkItemStore.start(item.hash);
    await flushBus();

    if (!started) throw new Error("expected the started projection");
    // The decision-class fact folded despite the crashing subscriber…
    expect(workFactsOf(item.hash).at(-1)?.type).toBe("work_item.started");
    expect(workHeadOf(item.hash)).toBe(started.revision);
    // …and the subscriber observed a head that was durable BEFORE delivery:
    // the publish is a delayed projection of the fact, never its cause.
    expect(headsAtDelivery).toEqual([started.revision]);
  });

  test("a forged NORMAL-durability telemetry row is rejected as a routing decision record", async () => {
    grantConformanceChannel();
    const workerSession = Session.create({
      title: "telemetry forge conformance",
      model: { providerID: "test", modelID: "test-model" },
    });
    // Forge bus_event telemetry claiming this inbound was already routed —
    // if telemetry could authorize, the engine would replay the forged
    // "decision" instead of deciding (and recording) itself.
    inspect
      .query(
        `INSERT INTO bus_event
           (session_id, run_id, event_type, category, visibility, data, trace_id, duration_ms, time_created)
         VALUES (NULL, NULL, 'ingress.routing.decision', 'ingress', 'internal', ?, 'trace-forged', NULL, 1)`,
      )
      .run(
        JSON.stringify({
          inboundId: "inbound-telemetry-forge",
          surface: "conformance",
          stage: "target",
          outcome: "route",
          sessionId: "session-forged-target",
        }),
      );

    const dispatchedSessions: string[] = [];
    const engine = createIngressEngine({
      coordinator: {
        dispatch: async (sessionId, request) => {
          dispatchedSessions.push(sessionId);
          return {
            runId: request.runId,
            sessionId,
            status: "succeeded" as const,
            output: "routed",
            finishReason: "stop" as const,
          };
        },
      },
    });
    const result = await engine.ingest(
      routedIngressEvent("inbound-telemetry-forge", workerSession.id),
    );

    // The engine decided FRESH: one fact at seq 1 on the owner stream — the
    // forged telemetry row was never consulted as a record, and the action
    // followed the fresh ledger-recorded resolution (the real worker
    // session), never the forged target.
    expect(dispatchedSessions).toEqual([workerSession.id]);
    expect(result.result.output).toBe("routed");
    const facts = factsOfStream(routeStreamOf("inbound-telemetry-forge"));
    expect(facts.map((fact) => [fact.seq, fact.type])).toEqual([[1, "route.decided"]]);
    const decided = LedgerAppend.RouteDecided.parse(JSON.parse(facts[0]?.data ?? "{}"));
    expect(decided.outcome).toBe("route");
    // The recorded fact is the fresh decision, not the forged payload.
    expect(JSON.parse(facts[0]?.data ?? "{}")).not.toMatchObject({
      sessionId: "session-forged-target",
    });
  });

  test("telemetry rows never advance an owner stream: bus_event writes leave ledger_event/ledger_head untouched", async () => {
    const countLedgerRows = () =>
      (inspect.query("SELECT COUNT(*) AS n FROM ledger_event").get() as { n: number }).n +
      (inspect.query("SELECT COUNT(*) AS n FROM ledger_head").get() as { n: number }).n;
    const before = countLedgerRows();
    inspect
      .query(
        `INSERT INTO bus_event
           (session_id, run_id, event_type, category, visibility, data, trace_id, duration_ms, time_created)
         VALUES (NULL, NULL, 'work_item.admission_accepted', 'work_item', 'internal', '{}', 'trace-telemetry', NULL, 1)`,
      )
      .run();
    expect(countLedgerRows()).toBe(before);
  });
});

describe("p2 ledger baseline — boot tail verification and the Governor incident", () => {
  const bootCompletionRuntime = {
    recoverRecordedWorkItemCompletions: async () => ({
      recovered: 0,
      skipped: 0,
      failures: [],
    }),
  };

  test("valid-tail boot succeeds: no chain-break, no Governor incident, recovery completes", async () => {
    await createConformanceWorkItem("boot-valid-tail");
    const events: { name: string; payload: Record<string, unknown> }[] = [];
    Bus.observe((event, payload) =>
      events.push({ name: event.name, payload: payload as Record<string, unknown> }),
    );

    await runRecovery({
      handler: undefined,
      traceId: "trace-boot-valid",
      completionRuntime: bootCompletionRuntime,
    });
    await flushBus();

    expect(events.some((event) => event.name === "operational.governor.incident")).toBe(false);
    expect(
      events.filter(
        (event) =>
          event.name === "operational.error" && String(event.payload.msg).includes("chain-break"),
      ),
    ).toEqual([]);
    expect(events.some((event) => event.name === "operational.recovery.completed")).toBe(true);
  });

  test("corrupted-tail boot emits chain-break plus Governor incident and does NOT refuse boot", async () => {
    const item = await createConformanceWorkItem("boot-corrupt-tail");
    const factsBefore = workFactsOf(item.hash).length;
    inspect
      .query("UPDATE ledger_event SET data = ? WHERE stream_id = ? AND seq = 1")
      .run('{"tampered":true}', `work:${item.hash}`);

    const events: { name: string; payload: Record<string, unknown> }[] = [];
    Bus.observe((event, payload) =>
      events.push({ name: event.name, payload: payload as Record<string, unknown> }),
    );

    await runRecovery({
      handler: undefined,
      traceId: "trace-boot-corrupt",
      completionRuntime: bootCompletionRuntime,
    });
    await flushBus();

    const chainBreaks = events.filter(
      (event) =>
        event.name === "operational.error" &&
        String(event.payload.msg).includes("ledger chain-break detected at boot"),
    );
    expect(chainBreaks).toHaveLength(1);
    const incidents = events.filter((event) => event.name === "operational.governor.incident");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.payload).toMatchObject({
      incident: "chain_break",
      component: "server",
      context: { streamId: `work:${item.hash}`, seq: 1, code: "hash_mismatch" },
    });
    // No refusal, and no post-break action: boot completed observe-only —
    // the tampered stream gained no fact and its head did not move.
    expect(events.some((event) => event.name === "operational.recovery.completed")).toBe(true);
    expect(workFactsOf(item.hash)).toHaveLength(factsBefore);
  });
});

describe("p2 ledger baseline — exact producer manifest", () => {
  const repoRoot = join(import.meta.dir, "..", "..");
  const adapterBinding = "packages/session/src/storage/sqlite-storage.ts";

  test("the observed ledger write surface equals the manifest in BOTH directions", async () => {
    const scan = await scanLedgerProducers(repoRoot);

    // Every `ledger.append`/`ledger.adoptStream` call site is a manifested
    // stream producer or the storage-adapter binding — and every manifested
    // producer still exists (a vanished producer is drift too).
    expect(LEDGER_PRODUCER_MANIFEST.appendCore).toContain(adapterBinding);
    expect([...scan.appendCallSites].sort()).toEqual(
      [...LEDGER_PRODUCER_MANIFEST.streams.map((entry) => entry.producer), adapterBinding].sort(),
    );

    // Raw ledger_event/ledger_head write SQL lives only in the append core.
    expect([...scan.ledgerTableWriters].sort()).toEqual(
      LEDGER_PRODUCER_MANIFEST.appendCore.filter((file) => file !== adapterBinding).sort(),
    );

    // Frozen-table write SQL survives only in the enumerated frozen
    // adapters (their store layers throw the typed frozen errors — pinned
    // above); any other module carrying it is an unmanifested writer.
    expect([...scan.frozenTableWriters].sort()).toEqual(
      LEDGER_PRODUCER_MANIFEST.frozenTableWriters.map((entry) => entry.adapter).sort(),
    );

    // Runtime-executed migration SQL is part of the write surface too: only
    // the enumerated historical backfills may write manifested tables.
    expect([...scan.migrationSqlWriters].sort()).toEqual(
      LEDGER_PRODUCER_MANIFEST.migrationSqlWriters.map((entry) => entry.file).sort(),
    );
  });

  test("red proofs: the scan catches the known evasion shapes", () => {
    // Multi-line, lowercase, OR REPLACE, against ledger_head.
    expect(
      matchesLedgerTableWriteSql(
        `db.query(\`insert or replace\n  into\n  ledger_head\n  (stream_id, head) VALUES (?, ?)\`)`,
      ),
    ).toBe(true);
    // Plain REPLACE INTO and UPDATE across line breaks.
    expect(matchesLedgerTableWriteSql("run(`REPLACE\nINTO ledger_event VALUES (?)`)")).toBe(true);
    expect(matchesFrozenTableWriteSql("db.exec(`UPDATE\n\tworker_run_state SET status=?`)")).toBe(
      true,
    );
    // Aliased receiver and bracket access.
    expect(matchesLedgerWriteCall("const out = subLedger.append(event, 0);")).toBe(true);
    expect(matchesLedgerWriteCall('ledger["append"]({ streamId }, 0);')).toBe(true);
    expect(matchesLedgerWriteCall('store["adoptStream"](id, 3, genesis);')).toBe(true);
    expect(
      matchesLedgerWriteCall("adapter.adoptStream(\n  streamId,\n  head,\n  genesis,\n)"),
    ).toBe(true);
    // Migration SQL (the 0005 shape) is caught after `--` comment stripping.
    expect(
      matchesMigrationTableWriteSql(
        "-- backfill\nUPDATE worker_run_state SET executor_kind = 'internal_chat_agent';",
      ),
    ).toBe(true);
    // Non-writes stay quiet: comment mentions, SELECTs, and prefix-named
    // tables (pending_ask_new) never trip the gate.
    expect(matchesLedgerWriteCall("// calls Ledger.append(event, expectedHead) later")).toBe(false);
    expect(matchesLedgerTableWriteSql("db.query(`SELECT * FROM ledger_event`)")).toBe(false);
    expect(matchesMigrationTableWriteSql("INSERT INTO pending_ask_new (id) VALUES (1);")).toBe(
      false,
    );
  });

  test("manifest stream classes equal the protocol StreamRegistry; one producer per class", () => {
    expect(LEDGER_PRODUCER_MANIFEST.streams.map((entry) => entry.streamClass).sort()).toEqual(
      Object.keys(LedgerAppend.StreamRegistry).sort(),
    );
    const producers = LEDGER_PRODUCER_MANIFEST.streams.map((entry) => entry.producer);
    expect(new Set(producers).size).toBe(producers.length);
  });

  test("the producer manifest and the archive manifest agree on the frozen-table set", () => {
    const archived = buildLedgerArchiveManifest(inspect).tables.map((entry) => entry.table);
    expect(LEDGER_PRODUCER_MANIFEST.frozenTableWriters.map((entry) => entry.table).sort()).toEqual(
      [...archived].sort(),
    );
  });
});
