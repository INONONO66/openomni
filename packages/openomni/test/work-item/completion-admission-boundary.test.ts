import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEngine } from "@openomni/policy";
import { PolicyDecision, WorkItem } from "@openomni/protocol";
import { SqliteStorageAdapter, Storage, WorkItemStore } from "@openomni/ledger";
import { Bus } from "@openomni/telemetry";
import * as OpenOmni from "../../src/index.js";
import {
  assertCompletionReservationLease,
  CompletionAdmissionError,
  completionRequestRoot,
  createCompletionAdmissionService,
  createWorkItemCompletionGateway,
  reserveCompletionRequest,
} from "../../src/work-item/completion-admission.js";
import * as WorkItemPublic from "../../src/work-item/index.js";

const NOW = 1_000;

// #606: WorkItemStore.update (the freeform field rewrite) is deleted. Tests
// that need a competing head advance append a marker evidence row instead —
// a real fact-backed mutation that bumps the row revision by exactly 1 and
// leaves status/blockers untouched. Survival of the competing write is
// asserted through the marker in stored.evidence.
function advanceHead(hash: string, marker: string): Promise<WorkItem.Info | undefined> {
  return WorkItemStore.addEvidence(
    hash,
    { kind: "verification", description: marker, passed: true },
    "trace-test",
  );
}

function evidenceDescriptions(item: WorkItem.Info | undefined): string[] {
  return item?.evidence.map(({ description }) => description) ?? [];
}
const adapters: SqliteStorageAdapter[] = [];
const databasePaths: string[] = [];
let completionWriter: Storage.WorkItemCompletionWriter;

function configure(dbPath = ":memory:"): SqliteStorageAdapter {
  const adapter = new SqliteStorageAdapter(dbPath);
  adapters.push(adapter);
  completionWriter = Storage.configure(adapter);
  return adapter;
}

function closeAdapter(adapter: SqliteStorageAdapter): void {
  const index = adapters.indexOf(adapter);
  if (index >= 0) adapters.splice(index, 1);
  adapter.close();
}

function removeDatabase(path: string): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    const candidate = `${path}${suffix}`;
    if (existsSync(candidate)) rmSync(candidate);
  }
}

type AuthorityCall = Readonly<{
  itemHead: number;
  requestHead: number;
  requestId: string;
}>;

function authority(decisions: readonly WorkItem.CompletionDecision[] = ["admit"]) {
  const calls: AuthorityCall[] = [];
  let decisionIndex = 0;
  return {
    calls,
    resolver: {
      resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
        const item = WorkItem.Info.parse(itemInput);
        const request = WorkItem.CompletionRequest.parse(requestInput);
        const decision = decisions[Math.min(decisionIndex, decisions.length - 1)] ?? "admit";
        decisionIndex += 1;
        calls.push({
          itemHead: item.revision,
          requestHead: request.expectedHead,
          requestId: request.id,
        });
        return admissionFrom(item, request, {
          id: `admission:${request.id}:${item.revision + 1}:${decisionIndex}`,
          effectiveResultIds:
            decision === "admit"
              ? [...item.completionFacts.results, ...request.results].map(({ id }) => id)
              : [],
          unresolvedCriterionIds:
            decision === "admit" ? [] : item.completionFacts.criteria.map(({ id }) => id),
          decision,
          reasonCodes: decision === "admit" ? [] : [`completion_${decision}`],
        });
      },
    },
  };
}

function blockingAuthority() {
  return {
    resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
      const item = WorkItem.Info.parse(itemInput);
      const request = WorkItem.CompletionRequest.parse(requestInput);
      return admissionFrom(item, request, {
        id: `admission:${request.id}:${item.revision + 1}:block`,
        effectiveResultIds: [],
        unresolvedCriterionIds: item.completionFacts.criteria.map(({ id }) => id),
        decision: "block",
        reasonCodes: ["completion_block"],
      });
    },
  };
}

function guardedService(
  authorityResolver: unknown,
  writer: Storage.WorkItemCompletionWriter = completionWriter,
  reservation?: Readonly<{
    ownerId: string;
    leaseDurationMs: number;
    requestRoot?: string;
    envelopeDigest?: string;
  }>,
  now: () => number = () => NOW,
) {
  const service = Reflect.apply(createCompletionAdmissionService, undefined, [
    {
      completionWriter: writer,
      decision: (item: WorkItem.Info, request: WorkItem.CompletionRequest) =>
        Promise.resolve(
          Reflect.apply(Reflect.get(authorityResolver as object, "resolve"), authorityResolver, [
            item,
            request,
          ]),
        ),
      now,
      reservation,
    },
  ]);
  expect(typeof service, "completion admission factory must return a service").toBe("object");
  if (typeof service !== "object" || service === null) return undefined;
  const requestCompletion = Reflect.get(service, "requestCompletion");
  const resumeCompletion = Reflect.get(service, "resumeCompletion");
  expect(typeof requestCompletion, "service must expose requestCompletion(request, report)").toBe(
    "function",
  );
  expect(
    typeof resumeCompletion,
    "service must expose resumeCompletion(hash, admissionId, report)",
  ).toBe("function");
  if (typeof requestCompletion !== "function" || typeof resumeCompletion !== "function") {
    return undefined;
  }

  return {
    requestCompletion(
      request: WorkItem.CompletionRequest,
      report: WorkItem.CompletionReport,
    ): Promise<unknown> {
      return Reflect.apply(requestCompletion, service, [
        request,
        report,
        { traceId: "trace-test" },
      ]);
    },
    resumeCompletion(
      hash: string,
      admissionId: string,
      report: WorkItem.CompletionReport,
    ): Promise<unknown> {
      return Reflect.apply(resumeCompletion, service, [hash, admissionId, report, "trace-test"]);
    },
  };
}

async function fixture(origin: WorkItem.CompletionOrigin = "worker", evidencePassed = true) {
  const item = await WorkItemStore.create(
    {
      name: `Admission ${origin}`,
      sourceMessageId: `msg_${origin}`,
      sourceChannel: "test",
      intent: "complete",
      goal: "close through one boundary",
      acceptanceCriteria: ["criterion one"],
    },
    "trace-test",
  );
  const withEvidence = await WorkItemStore.addEvidence(
    item.workItemId,
    {
      kind: "verification",
      description: "boundary fixture",
      passed: evidencePassed,
    },
    "trace-test",
  );
  const current = WorkItemStore.get(item.workItemId);
  const criterion = current?.completionFacts.criteria[0];
  const evidenceId = withEvidence?.evidence.at(-1)?.id;
  if (!current || !criterion || !evidenceId) throw new Error("missing boundary fixture");
  const request = completionRequest(current, origin);
  const report: WorkItem.CompletionReport = {
    summary: "Completed through admission.",
    claims: [{ statement: criterion.statement, evidenceIds: [evidenceId] }],
    caveats: [],
    followUps: [],
  };
  return { item: current, request, report };
}

function completionRequest(
  item: WorkItem.Info,
  origin: WorkItem.CompletionOrigin = "worker",
): WorkItem.CompletionRequest {
  const criterion = item.completionFacts.criteria[0];
  const evidenceId = item.evidence[0]?.id;
  if (!criterion || !evidenceId) throw new Error("missing completion criterion evidence");
  const observationId = `observation:${item.workItemId}:${item.revision}`;
  return WorkItem.CompletionRequest.parse({
    version: 1,
    id: `completion-request:${item.workItemId}:${item.revision}:${origin}`,
    origin,
    workItemHash: item.workItemId,
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    expectedHead: item.revision,
    claims: [
      {
        id: `claim:${item.workItemId}:${item.revision}`,
        criterionId: criterion.id,
        statement: criterion.statement,
        observationIds: [observationId],
        basisRef: item.completionContract.basisRef,
        createdAt: NOW,
      },
    ],
    observations: [
      {
        id: observationId,
        producer: "test:boundary",
        subjectRef: item.workItemId,
        basisRef: item.completionContract.basisRef,
        artifactRefs: [evidenceId],
        provenanceRef: evidenceId,
        ancestryRefs: [],
        observedAt: NOW,
      },
    ],
    results: [
      {
        id: `result:${item.workItemId}:${item.revision}`,
        criterionId: criterion.id,
        value: "verified",
        checkedPredicate: criterion.statement,
        observationIds: [observationId],
        verifierRef: "verifier:test",
        assumptions: [],
        basisRef: item.completionContract.basisRef,
        residualRisks: [],
        createdAt: NOW,
      },
    ],
    invalidations: [],
    verificationErrors: [],
    effects: [],
  });
}

function completionEvents(
  hash: string,
  onFirstAdmission?: () => void,
): Readonly<{
  order: string[];
  admissionStates: WorkItem.Info[];
  admissionRecorded: Promise<void>;
  completed: Promise<void>;
  stop: () => void;
}> {
  const order: string[] = [];
  const admissionStates: WorkItem.Info[] = [];
  let resolveAdmission: () => void = () => undefined;
  let resolveCompleted: () => void = () => undefined;
  const admissionRecorded = new Promise<void>((resolve) => {
    resolveAdmission = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  let admissionCount = 0;
  const subscriptions = [
    Bus.subscribe(WorkItem.Events.CompletionRequested, (event) => {
      if (event.payload.workItemHash === hash) order.push("CompletionRequested");
    }),
    Bus.subscribe(WorkItem.Events.CompletionAdmissionRecorded, (event) => {
      if (event.payload.workItemId !== hash) return;
      order.push("CompletionAdmissionRecorded");
      const stored = WorkItemStore.get(hash);
      if (stored) admissionStates.push(stored);
      admissionCount += 1;
      if (admissionCount === 1) onFirstAdmission?.();
      resolveAdmission();
    }),
    Bus.subscribe(WorkItem.Events.CompletedV2, (event) => {
      if (event.payload.hash !== hash) return;
      order.push("CompletedV2");
      resolveCompleted();
    }),
  ];
  return {
    order,
    admissionStates,
    admissionRecorded,
    completed,
    stop: () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    },
  };
}

async function errorCode(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (typeof error !== "object" || error === null) throw error;
    return Reflect.get(error, "code");
  }
  return undefined;
}

function admissionIdentity(request: WorkItem.CompletionRequest) {
  return {
    workItemHash: request.workItemHash,
    sourceIdentity: request.sourceIdentity,
    requestRoot: completionRequestRoot(request),
    proposedFactIds: {
      claims: request.claims.map(({ id }) => id),
      observations: request.observations.map(({ id }) => id),
      results: request.results.map(({ id }) => id),
      invalidations: request.invalidations.map(({ id }) => id),
      verificationErrors: request.verificationErrors.map(({ id }) => id),
      effects: request.effects.map(({ id }) => id),
    },
  };
}

/** One canonical admit-shaped admission for (item, request); vary via overrides. */
function admissionFrom(
  item: WorkItem.Info,
  request: WorkItem.CompletionRequest,
  overrides: Readonly<Record<string, unknown>> = {},
): WorkItem.CompletionAdmission {
  return WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${request.id}:${item.revision + 1}`,
    requestId: request.id,
    ...admissionIdentity(request),
    origin: request.origin,
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    effectiveResultIds: request.results.map(({ id }) => id),
    unresolvedCriterionIds: [],
    decision: "admit",
    reasonCodes: [],
    residualRisks: [],
    policyRef: "policy:test",
    expectedHead: item.revision,
    recordedHead: item.revision + 1,
    createdAt: NOW,
    ...overrides,
  });
}

afterEach(() => {
  Bus.reset();
  Storage.reset();
  for (const adapter of adapters.splice(0)) adapter.close();
  for (const path of databasePaths.splice(0)) removeDatabase(path);
});

/**
 * Typed replacement for the file's older Reflect.get idiom: returns unknown
 * (never any) and fails the test loudly when the key is absent instead of
 * yielding undefined into a matcher.
 */
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) {
    throw new Error(`shape: missing ${key}`);
  }
  return (value as Record<string, unknown>)[key];
}

describe("WorkItem completion admission service", () => {
  test("D11 pin: the terminal commit's three events share the request's ONE traceId", async () => {
    configure();
    const first = await fixture("worker");
    const traces: Array<{ event: string; traceId: string }> = [];
    Bus.subscribe(WorkItem.Events.CompletionRequested, (event) => {
      if (event.payload.workItemHash === first.item.workItemId) {
        traces.push({ event: "requested", traceId: event.traceId });
      }
    });
    Bus.subscribe(WorkItem.Events.CompletionAdmissionRecorded, (event) => {
      if (event.payload.workItemId === first.item.workItemId) {
        traces.push({ event: "admission", traceId: event.traceId });
      }
    });
    Bus.subscribe(WorkItem.Events.StatusChanged, (event) => {
      if (event.payload.workItemId === first.item.workItemId) {
        traces.push({
          event: `status:${event.payload.from}->${event.payload.to}`,
          traceId: event.traceId,
        });
      }
    });
    Bus.subscribe(WorkItem.Events.Updated, (event) => {
      if (event.payload.workItemId === first.item.workItemId) {
        traces.push({ event: "updated", traceId: event.traceId });
      }
    });
    Bus.subscribe(WorkItem.Events.CompletedV2, (event) => {
      if (event.payload.hash === first.item.workItemId) {
        traces.push({ event: "completed", traceId: event.traceId });
      }
    });
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW,
    });

    const outcome = await gateway.requestCompletion(first.request, first.report, {
      traceId: "trace-commit",
    });

    expect(Reflect.get(outcome, "completed")).toBe(true);
    // The whole request funnel — CompletionRequested, the admission record,
    // and the atomic terminal commit's StatusChanged + Updated + CompletedV2
    // — carries the caller's ONE traceId (was 5 per-publish mints pre-D11).
    expect(traces).toEqual([
      { event: "requested", traceId: "trace-commit" },
      { event: "admission", traceId: "trace-commit" },
      { event: "status:pending->completed", traceId: "trace-commit" },
      { event: "updated", traceId: "trace-commit" },
      { event: "completed", traceId: "trace-commit" },
    ]);
  });

  test("uses one kernel-internal guarded completion gateway for non-Worker origins", async () => {
    configure();
    expect(Reflect.get(OpenOmni, "createWorkItemCompletionGateway")).toBeUndefined();
    expect(Reflect.get(OpenOmni, "createCompletionAdmissionService")).toBeUndefined();
    expect(Reflect.get(OpenOmni, "createCompletionAuthorityResolver")).toBeUndefined();
    const first = await fixture("external_actor");
    const trustedResult = first.request.results[0];
    if (!trustedResult) throw new Error("missing public gateway result");
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: {
        validate(candidate: unknown) {
          const result = Reflect.get(candidate as object, "result");
          return { ok: WorkItem.CriterionResult.safeParse(result).success };
        },
      },
      now: () => NOW,
    });

    const outcome = await gateway.requestCompletion(first.request, first.report, {
      traceId: "trace-test",
    });

    expect(Reflect.get(outcome, "completed")).toBe(true);
    expect(WorkItemStore.get(first.item.workItemId)?.completionTerminalReceipt?.admissionId).toBe(
      WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions[0]?.id,
    );
  });

  test("keeps the configurable gateway private while recovering recorded admissions", async () => {
    expect(Reflect.get(OpenOmni, "createWorkItemCompletionGateway")).toBeUndefined();
    expect(Reflect.get(WorkItemPublic, "createWorkItemCompletionGateway")).toBeUndefined();
    const adapter = configure();
    const first = await fixture("recovery");
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW,
    });
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    class SimulatedBootCrash extends Error {}
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (candidate.completionTerminalReceipt !== undefined) {
        throw new SimulatedBootCrash("crash before terminal append");
      }
      return compareAndSet(hash, expectedHead, candidate);
    };

    await expect(
      gateway.requestCompletion(first.request, first.report, { traceId: "trace-test" }),
    ).rejects.toBeInstanceOf(SimulatedBootCrash);
    adapter.workItem.compareAndSet = compareAndSet;

    const receipt = await gateway.recoverRecordedCompletions("trace-test");

    expect(receipt).toEqual({
      recovered: 1,
      skipped: 0,
      failures: [],
    });
    const recovered = WorkItemStore.get(first.item.workItemId);
    if (!recovered) throw new Error("missing recovered WorkItem");
    expect(WorkItem.deriveStatus(recovered)).toBe("completed");
  });

  test("releases a pre-admission reservation during boot recovery", async () => {
    configure();
    const first = await fixture("worker");
    const blockingService = guardedService(blockingAuthority());
    if (!blockingService) return;
    await blockingService.requestCompletion(first.request, first.report);
    await WorkItemStore.fail(
      first.item.workItemId,
      "trace-test",
      "retry after historical admission",
    );
    const retried = await WorkItemStore.retry(first.item.workItemId, "trace-test");
    if (!retried) throw new Error("missing retried WorkItem");
    const reservationInput = {
      completionWriter,
      workItemHash: retried.workItemId,
      requestId: "completion-request:pre-admission-recovery:retry",
      requestRoot: "request-root:pre-admission-recovery",
      envelopeDigest: "digest:pre-admission-recovery",
      leaseDurationMs: 15_000,
    };
    const reserved = reserveCompletionRequest({
      ...reservationInput,
      ownerId: "process:before-restart",
      now: NOW,
    });
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW,
    });

    const receipt = await gateway.recoverRecordedCompletions("trace-test");
    const afterRecovery = WorkItemStore.get(retried.workItemId);
    const staleHolder = reserveCompletionRequest({
      ...reservationInput,
      ownerId: "process:before-restart",
      now: NOW - 1,
    });
    const takeover = reserveCompletionRequest({
      ...reservationInput,
      ownerId: "process:after-restart",
      now: NOW,
    });

    expect(receipt).toEqual({ recovered: 0, skipped: 1, failures: [] });
    expect(afterRecovery?.completionFacts.admissions).toHaveLength(1);
    expect(
      afterRecovery?.completionFacts.admissions.some(
        ({ basisRef }) => basisRef === retried.completionContract.basisRef,
      ),
    ).toBe(false);
    const recoveryFence = afterRecovery?.completionFacts.requestReservations.at(-1);
    expect(recoveryFence).toMatchObject({
      fence: reserved.reservation.fence + 1,
      leaseExpiresAt: NOW,
    });
    expect(recoveryFence?.id).not.toBe(reserved.reservation.id);
    expect(recoveryFence?.ownerId?.startsWith("completion-recovery:")).toBe(true);
    expect(staleHolder.state).toBe("busy");
    expect(takeover.state).toBe("reserved");
    expect(takeover.reservation.ownerId).toBe("process:after-restart");
    expect(takeover.reservation.fence).toBe(reserved.reservation.fence + 2);
  });

  test("skips recovery admissions from a prior retry generation", async () => {
    const adapter = configure();
    const first = await fixture("recovery");
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW,
    });
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    class SimulatedBootCrash extends Error {}
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (candidate.completionTerminalReceipt !== undefined) {
        throw new SimulatedBootCrash("crash before terminal append");
      }
      return compareAndSet(hash, expectedHead, candidate);
    };
    await expect(
      gateway.requestCompletion(first.request, first.report, { traceId: "trace-test" }),
    ).rejects.toBeInstanceOf(SimulatedBootCrash);
    adapter.workItem.compareAndSet = compareAndSet;
    await WorkItemStore.fail(first.item.workItemId, "trace-test", "retry after crashed completion");
    await WorkItemStore.retry(first.item.workItemId, "trace-test");

    const receipt = await gateway.recoverRecordedCompletions("trace-test");

    expect(receipt).toEqual({ recovered: 0, skipped: 1, failures: [] });
    expect(WorkItemStore.get(first.item.workItemId)?.completionTerminalReceipt).toBeUndefined();
  });

  test("recovers a recorded block admission into one deterministic blocker", async () => {
    configure();
    const first = await fixture();
    const policyEngine = PolicyEngine.create();
    policyEngine.register({
      kind: "point",
      name: "recorded-block-recovery",
      pointIds: ["work.complete.pre"],
      effectCapabilities: { "work.complete.pre": [] },
      priority: 0,
      fn: () =>
        PolicyDecision.deny({
          policyId: "recorded-block-recovery",
          reasonCodes: ["recorded_block_recovery"],
        }),
    });
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine,
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW,
    });

    const outcome = await gateway.requestCompletion(first.request, first.report, {
      traceId: "trace-test",
    });
    expect(outcome.completed).toBe(false);
    expect(outcome.admission.decision).toBe("block");
    expect(WorkItemStore.get(first.item.workItemId)?.blockers).toEqual([]);
    await WorkItemStore.addEvidence(
      first.item.workItemId,
      {
        kind: "verification",
        description: "head changed after recorded block",
        passed: true,
      },
      "trace-test",
    );

    const receipt = await gateway.recoverRecordedCompletions("trace-test");
    const recovered = WorkItemStore.get(first.item.workItemId);
    const reevaluatedAdmission = recovered?.completionFacts.admissions.at(-1);
    expect(receipt).toEqual({ recovered: 1, skipped: 0, failures: [] });
    expect(recovered?.completionFacts.admissions).toHaveLength(2);
    expect(reevaluatedAdmission?.id).not.toBe(outcome.admission.id);
    expect(reevaluatedAdmission?.decision).toBe("block");
    expect(recovered?.blockers).toHaveLength(1);
    expect(recovered?.blockers[0]?.id).toBe(`${reevaluatedAdmission?.id}:blocker`);

    const replay = await gateway.recoverRecordedCompletions("trace-test");
    expect(replay).toEqual({ recovered: 0, skipped: 1, failures: [] });
    expect(WorkItemStore.get(first.item.workItemId)?.blockers).toHaveLength(1);
  });

  test("materializes a blocker when stale-admission recovery re-evaluates to block", async () => {
    const adapter = configure();
    const first = await fixture("recovery");
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW,
    });
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    class SimulatedBootCrash extends Error {}
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (candidate.completionTerminalReceipt !== undefined) {
        throw new SimulatedBootCrash("crash before terminal append");
      }
      return compareAndSet(hash, expectedHead, candidate);
    };

    await expect(
      gateway.requestCompletion(first.request, first.report, { traceId: "trace-test" }),
    ).rejects.toBeInstanceOf(SimulatedBootCrash);
    adapter.workItem.compareAndSet = compareAndSet;
    const admitted = WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions.at(-1);
    if (!admitted) throw new Error("missing crashed completion admission");
    await WorkItemStore.addBlocker(
      first.item.workItemId,
      {
        kind: "external",
        description: "external state changed before restart",
      },
      "trace-test",
    );

    const receipt = await gateway.recoverRecordedCompletions("trace-test");

    expect(receipt).toEqual({ recovered: 1, skipped: 0, failures: [] });
    const recovered = WorkItemStore.get(first.item.workItemId);
    if (!recovered) throw new Error("missing blocked recovery WorkItem");
    expect(WorkItem.deriveStatus(recovered)).toBe("blocked");
    expect(recovered.blockers).toHaveLength(2);
    expect(recovered.blockers.at(-1)?.description).toContain("completion admission block");
  });

  test("holds completion reservations across process owners until lease expiry", async () => {
    configure();
    const { item, request } = await fixture("worker");
    const base = {
      completionWriter,
      workItemHash: item.workItemId,
      requestId: request.id,
      requestRoot: "request-root:reservation-lease",
      envelopeDigest: "digest:reservation-lease",
      leaseDurationMs: 10,
    };

    const first = reserveCompletionRequest({
      ...base,
      ownerId: "process:one",
      now: 100,
    });
    const busy = reserveCompletionRequest({
      ...base,
      ownerId: "process:two",
      now: 109,
    });
    const takeover = reserveCompletionRequest({
      ...base,
      ownerId: "process:two",
      now: 110,
    });
    const renewal = reserveCompletionRequest({
      ...base,
      ownerId: "process:two",
      now: 120,
    });

    expect(first).toMatchObject({
      state: "reserved",
      reservation: { ownerId: "process:one", fence: 1, leaseExpiresAt: 110 },
    });
    expect(busy).toMatchObject({
      state: "busy",
      reservation: { ownerId: "process:one", fence: 1 },
    });
    expect(takeover).toMatchObject({
      state: "reserved",
      reservation: { ownerId: "process:two", fence: 2, leaseExpiresAt: 120 },
    });
    expect(renewal).toMatchObject({
      state: "reserved",
      reservation: { ownerId: "process:two", fence: 3, leaseExpiresAt: 130 },
    });
  });

  test("rejects same-request reservation root and digest conflicts", async () => {
    configure();
    const { item, request } = await fixture("worker");
    const input = {
      completionWriter,
      workItemHash: item.workItemId,
      requestId: request.id,
      ownerId: "process:one",
      leaseDurationMs: 10,
      now: 100,
    };
    reserveCompletionRequest({
      ...input,
      requestRoot: "request-root:one",
      envelopeDigest: "digest:one",
    });

    expect(() =>
      reserveCompletionRequest({
        ...input,
        requestRoot: "request-root:two",
        envelopeDigest: "digest:one",
      }),
    ).toThrow("completion request conflicts with durable facts");
    expect(() =>
      reserveCompletionRequest({
        ...input,
        requestRoot: "request-root:one",
        envelopeDigest: "digest:two",
      }),
    ).toThrow("completion envelope changed for request");
  });

  test("binds pre-admission reservations to the authenticated request envelope", async () => {
    configure();
    const { item, request, report } = await fixture("resident");
    const fallback = authority().resolver;
    let failAuthority = true;
    const service = guardedService(
      {
        resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
          if (failAuthority) {
            failAuthority = false;
            throw new Error("authority failed before admission");
          }
          return fallback.resolve(itemInput, requestInput);
        },
      },
      completionWriter,
      { ownerId: "process:one", leaseDurationMs: 10_000 },
    );
    if (!service) return;

    await expect(service.requestCompletion(request, report)).rejects.toThrow(
      "authority failed before admission",
    );
    const changedSource = WorkItem.CompletionRequest.parse({
      ...request,
      sourceIdentity: {
        source: "resident",
        identity: { kind: "resident", id: "resident:replacement" },
      },
    });

    expect(await errorCode(service.requestCompletion(changedSource, report))).toBe(
      "request_conflict",
    );
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
  });

  test("preserves an Owner receipt across the reservation's own head advance", async () => {
    configure();
    const { request, report } = await fixture("resident");
    const ownerOverrideReceiptRef = "owner-receipt:reserved-request";
    const ownerRequest = WorkItem.CompletionRequest.parse({
      ...request,
      ownerOverrideReceiptRef,
    });
    const service = guardedService(
      {
        resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
          const item = WorkItem.Info.parse(itemInput);
          const candidate = WorkItem.CompletionRequest.parse(requestInput);
          return admissionFrom(item, candidate, {
            id: `admission:${candidate.id}:${item.revision + 1}:owner`,
            effectiveResultIds: [...item.completionFacts.results, ...candidate.results].map(
              ({ id }) => id,
            ),
            decision: "owner_override",
            ownerOverrideReceiptRef,
            policyRef: "policy:owner-reservation",
          });
        },
      },
      completionWriter,
      { ownerId: "process:owner", leaseDurationMs: 10_000 },
    );
    if (!service) return;

    const result = await service.requestCompletion(ownerRequest, report);
    expect(result).toMatchObject({
      completed: true,
      admission: { decision: "owner_override", ownerOverrideReceiptRef },
    });
    const resultAdmission = field(result, "admission");
    expect(field(resultAdmission, "ownerOverrideReceiptRef")).toBe(ownerOverrideReceiptRef);
  });

  test("closes an Owner override without synthesizing a missing result", async () => {
    configure();
    const { item, request, report } = await fixture("resident");
    const ownerOverrideReceiptRef = "owner-receipt:missing-result";
    const ownerRequest = WorkItem.CompletionRequest.parse({
      ...request,
      ownerOverrideReceiptRef,
      results: [],
    });
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      ownerOverrideValidator: (candidate: unknown) => {
        expect(candidate).toMatchObject({
          receiptRef: ownerOverrideReceiptRef,
          workItemHash: item.workItemId,
          requestId: ownerRequest.id,
          requestRoot: completionRequestRoot(ownerRequest),
        });
        return true;
      },
      now: () => NOW,
    });

    const result = await gateway.requestCompletion(ownerRequest, report, { traceId: "trace-test" });
    expect(result).toMatchObject({
      completed: true,
      admission: {
        decision: "owner_override",
        unresolvedCriterionIds: [item.completionFacts.criteria[0]?.id],
      },
    });
    const completed = WorkItemStore.get(item.workItemId);
    expect(completed?.completionFacts.results).toEqual([]);
    expect(completed?.completionFacts.claims).toHaveLength(1);
    expect(completed?.completionFacts.observations).toHaveLength(1);
  });

  test("does not preserve an Owner receipt across external one-head drift", async () => {
    configure();
    const { item, request, report } = await fixture("resident");
    const ownerOverrideReceiptRef = "owner-receipt:stale-after-drift";
    const ownerRequest = WorkItem.CompletionRequest.parse({
      ...request,
      ownerOverrideReceiptRef,
    });
    let injectExternalHead = true;
    const driftingWriter: Storage.WorkItemCompletionWriter = (hash, expectedRevision, next) => {
      const current = WorkItemStore.get(hash);
      if (
        injectExternalHead &&
        current &&
        next.completionFacts.requestReservations.length >
          current.completionFacts.requestReservations.length
      ) {
        injectExternalHead = false;
        const advanced = WorkItem.Info.parse({
          ...current,
          revision: current.revision + 1,
          timestamps: { ...current.timestamps, updated: current.timestamps.updated + 1 },
        });
        // External drift is a FULL write (#510 C1): its decision-class fact
        // appends before the projection CAS in one transaction, keeping the
        // owner-stream head equal to the drifted revision.
        const storage = Storage.get();
        storage.transaction(() => {
          // Both halves must land (loud, not best-effort): a silently failed
          // fact append or projection CAS would mean the drift this test
          // depends on never happened, masking the regression it simulates.
          const appended = storage.ledger?.append(
            {
              streamId: `work:${hash}`,
              type: "work_item.updated",
              data: { fields: ["timestamps"], revision: advanced.revision },
            },
            current.revision,
          );
          if (appended?.kind !== "appended") {
            throw new Error("external drift fact append failed — fixture drift did not happen");
          }
          if (!storage.workItem?.compareAndSet(hash, expectedRevision, advanced)) {
            throw new Error("external drift projection CAS failed — fixture drift did not happen");
          }
        });
      }
      return completionWriter(hash, expectedRevision, next);
    };
    const service = guardedService(
      {
        resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
          const current = WorkItem.Info.parse(itemInput);
          const candidate = WorkItem.CompletionRequest.parse(requestInput);
          if (candidate.ownerOverrideReceiptRef !== ownerOverrideReceiptRef) {
            throw new CompletionAdmissionError(
              "request_conflict",
              "Owner receipt changed after external head drift",
            );
          }
          return admissionFrom(current, candidate, {
            id: `admission:${candidate.id}:${current.revision + 1}:owner`,
            effectiveResultIds: [...current.completionFacts.results, ...candidate.results].map(
              ({ id }) => id,
            ),
            decision: "owner_override",
            ownerOverrideReceiptRef,
            policyRef: "policy:owner-stale-drift",
          });
        },
      },
      driftingWriter,
      { ownerId: "process:owner-drift", leaseDurationMs: 10_000 },
    );
    if (!service) return;

    expect(await errorCode(service.requestCompletion(ownerRequest, report))).toBe(
      "request_conflict",
    );
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
  });

  test("recovery reuses a durable custom reservation identity", async () => {
    configure();
    const { item, request, report } = await fixture("worker");
    const resolver = authority().resolver;
    const crashingWriter: Storage.WorkItemCompletionWriter = (hash, expectedRevision, next) => {
      if (next.completionTerminalReceipt) throw new Error("crash before terminal CAS");
      return completionWriter(hash, expectedRevision, next);
    };
    const workerService = guardedService(resolver, crashingWriter, {
      ownerId: "process:worker",
      leaseDurationMs: 15_000,
      requestRoot: "worker-request-root",
      envelopeDigest: "worker-envelope-digest",
    });
    if (!workerService) return;

    await expect(workerService.requestCompletion(request, report)).rejects.toThrow(
      "crash before terminal CAS",
    );
    const interrupted = WorkItemStore.get(item.workItemId);
    const originalAdmission = interrupted?.completionFacts.admissions.find(
      ({ requestId }) => requestId === request.id,
    );
    expect(originalAdmission).toBeDefined();
    if (!originalAdmission) throw new Error("shape");
    expect(
      interrupted?.completionFacts.requestReservations.find(
        ({ requestId }) => requestId === request.id,
      ),
    ).toMatchObject({
      requestId: request.id,
      requestRoot: "worker-request-root",
      envelopeDigest: "worker-envelope-digest",
    });
    expect(interrupted?.completionTerminalReceipt).toBeUndefined();

    const interruptedRecoveryGateway = createWorkItemCompletionGateway({
      completionWriter: crashingWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW + 1,
    });
    const interruptedRecovery =
      await interruptedRecoveryGateway.recoverRecordedCompletions("trace-test");
    expect(interruptedRecovery).toMatchObject({
      recovered: 0,
      skipped: 0,
      failures: [{ admissionId: originalAdmission?.id }],
    });
    const afterInterruptedRecovery = WorkItemStore.get(item.workItemId);
    expect(afterInterruptedRecovery?.completionFacts.admissions.map(({ id }) => id)).toEqual([
      originalAdmission?.id,
    ]);
    expect(afterInterruptedRecovery?.completionTerminalReceipt).toBeUndefined();
    expect(await interruptedRecoveryGateway.recoverRecordedCompletions("trace-test")).toMatchObject(
      {
        recovered: 0,
        skipped: 0,
        failures: [{ admissionId: originalAdmission?.id }],
      },
    );
    expect(
      WorkItemStore.get(item.workItemId)?.completionFacts.admissions.map(({ id }) => id),
    ).toEqual([originalAdmission?.id]);

    const recoveryGateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: {
        validate: () => {
          throw new Error("recorded admission must not re-run authority");
        },
      },
      now: () => NOW + 2,
    });
    expect(await recoveryGateway.recoverRecordedCompletions("trace-test")).toEqual({
      recovered: 1,
      skipped: 0,
      failures: [],
    });
    const recovered = WorkItemStore.get(item.workItemId);
    expect(recovered?.completionFacts.admissions.map(({ id }) => id)).toEqual([
      originalAdmission?.id,
    ]);
    expect(recovered?.completionTerminalReceipt).toMatchObject({
      requestId: request.id,
      admissionId: originalAdmission?.id,
    });
  });

  test("request replay reuses the original admission after reservation takeover", async () => {
    configure();
    const { item, request, report } = await fixture("worker");
    const resolver = authority().resolver;
    const crashingWriter: Storage.WorkItemCompletionWriter = (hash, expectedRevision, next) => {
      if (next.completionTerminalReceipt) throw new Error("crash before replay terminal");
      return completionWriter(hash, expectedRevision, next);
    };
    const firstService = guardedService(
      resolver,
      crashingWriter,
      { ownerId: "process:replay-first", leaseDurationMs: 1 },
      () => NOW,
    );
    if (!firstService) return;

    await expect(firstService.requestCompletion(request, report)).rejects.toThrow(
      "crash before replay terminal",
    );
    const originalAdmission = WorkItemStore.get(item.workItemId)?.completionFacts.admissions[0];
    expect(originalAdmission).toBeDefined();
    if (!originalAdmission) throw new Error("shape");

    const replayService = guardedService(
      {
        resolve(): never {
          throw new Error("request replay must not re-run authority");
        },
      },
      completionWriter,
      { ownerId: "process:replay-second", leaseDurationMs: 1 },
      () => NOW + 2,
    );
    if (!replayService) return;
    const replay = await replayService.requestCompletion(request, report);

    expect(replay).toMatchObject({
      completed: true,
      admission: { id: originalAdmission?.id },
      workItem: {
        completionTerminalReceipt: { admissionId: originalAdmission?.id },
      },
    });
    const replayWorkItem = WorkItem.Info.parse(field(replay, "workItem"));
    expect(replayWorkItem.completionFacts.admissions.map(({ id }) => id)).toEqual([
      originalAdmission.id,
    ]);
  });

  test("takes over an expired nonterminal admission reservation after head drift", async () => {
    configure();
    const first = await fixture("worker");
    const reservationInput = {
      completionWriter,
      workItemHash: first.item.workItemId,
      requestId: first.request.id,
      requestRoot: "request-root:admitted-takeover",
      envelopeDigest: "digest:admitted-takeover",
      leaseDurationMs: 10,
    };
    const initial = reserveCompletionRequest({
      ...reservationInput,
      ownerId: "process:one",
      now: 100,
    });
    const reservedItem = WorkItemStore.get(first.item.workItemId);
    if (!reservedItem) throw new Error("missing reserved WorkItem");
    const requestSnapshot = WorkItem.CompletionRequest.parse({
      ...first.request,
      expectedHead: reservedItem.revision,
    });
    const report = WorkItem.canonicalCompletionReport(first.report);
    const admission = admissionFrom(reservedItem, requestSnapshot, {
      id: `admission:${first.request.id}:takeover`,
      policyRef: "policy:admitted-takeover",
      completionReportSnapshot: report,
      completionReportRef: WorkItem.completionReportReference(report),
      createdAt: 101,
    });
    const admittedItem = WorkItem.Info.parse({
      ...reservedItem,
      revision: admission.recordedHead,
      completionFacts: {
        ...reservedItem.completionFacts,
        revision: reservedItem.completionFacts.revision + 1,
        admissions: [...reservedItem.completionFacts.admissions, admission],
      },
      timestamps: { ...reservedItem.timestamps, updated: admission.createdAt },
    });
    expect(completionWriter(first.item.workItemId, reservedItem.revision, admittedItem)).toBe(true);
    await WorkItemStore.addEvidence(
      first.item.workItemId,
      {
        kind: "verification",
        description: "head drift after admission",
        passed: true,
      },
      "trace-test",
    );

    const takeover = reserveCompletionRequest({
      ...reservationInput,
      ownerId: "process:two",
      now: 111,
    });

    expect(initial.state).toBe("reserved");
    expect(takeover.state).toBe("reserved");
    expect(takeover.reservation.fence).toBe(initial.reservation.fence + 1);
    expect(() =>
      assertCompletionReservationLease({
        workItemHash: first.item.workItemId,
        requestId: first.request.id,
        reservationId: takeover.reservation.id,
        ownerId: "process:two",
        fence: takeover.reservation.fence,
        now: 111,
      }),
    ).not.toThrow();
  });

  test("bounds persistent completion reservation CAS contention", async () => {
    configure();
    const first = await fixture("worker");

    expect(() =>
      reserveCompletionRequest({
        completionWriter: () => false,
        workItemHash: first.item.workItemId,
        requestId: first.request.id,
        requestRoot: "request-root:persistent-contention",
        envelopeDigest: "digest:persistent-contention",
        ownerId: "process:contended",
        leaseDurationMs: 10,
        now: 100,
      }),
    ).toThrow("completion reservation contention did not converge");
    expect(WorkItemStore.get(first.item.workItemId)?.completionFacts.requestReservations).toEqual(
      [],
    );
  });

  test("rejects a reservation id colliding with a completion fact", async () => {
    configure();
    const first = await fixture("worker");
    const current = WorkItemStore.get(first.item.workItemId);
    if (!current) throw new Error("missing collision fixture WorkItem");
    const reservationId = `completion-reservation:${first.request.id}:1`;
    const candidate = WorkItem.Info.parse({
      ...current,
      revision: current.revision + 1,
      completionFacts: {
        ...current.completionFacts,
        revision: current.completionFacts.revision + 1,
        claims: [
          ...current.completionFacts.claims,
          {
            id: reservationId,
            criterionId: current.completionFacts.criteria[0]?.id ?? "criterion:missing",
            statement: "reservation ids remain globally unique",
            observationIds: [],
            basisRef: current.completionContract.basisRef,
            createdAt: 99,
          },
        ],
      },
    });
    expect(completionWriter(current.workItemId, current.revision, candidate)).toBe(true);

    expect(() =>
      reserveCompletionRequest({
        completionWriter,
        workItemHash: first.item.workItemId,
        requestId: first.request.id,
        requestRoot: "request-root:collision",
        envelopeDigest: "digest:collision",
        ownerId: "process:collision",
        leaseDurationMs: 10,
        now: 100,
      }),
    ).toThrow(`completion reservation id collides with completion fact: ${reservationId}`);
    expect(WorkItemStore.get(first.item.workItemId)?.completionFacts.requestReservations).toEqual(
      [],
    );
  });

  test("keeps the terminal service factory off public package barrels", () => {
    expect(Reflect.get(OpenOmni, "createCompletionAdmissionService")).toBeUndefined();
    expect(Reflect.get(WorkItemPublic, "createCompletionAdmissionService")).toBeUndefined();
  });

  test("exposes one public record-before-act service for every completion origin", async () => {
    configure();
    const origins = ["resident", "worker", "external_actor", "replay", "recovery"] as const;

    for (const origin of origins) {
      const { item, request, report } = await fixture(origin);
      const admissionAuthority = authority();
      const service = guardedService(admissionAuthority.resolver);
      if (!service) return;
      const events = completionEvents(item.workItemId);

      await service.requestCompletion(request, report);
      await events.completed;
      events.stop();

      const stored = WorkItemStore.get(item.workItemId);
      expect(stored?.completionFacts.admissions[0]?.origin).toBe(origin);
      expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("completed");
      expect(events.order).toEqual([
        "CompletionRequested",
        "CompletionAdmissionRecorded",
        "CompletedV2",
      ]);
    }
  });

  test("refuses raw storage callers that append a completion admission", async () => {
    const adapter = configure();
    const first = await fixture("external_actor");
    const admission = await authority().resolver.resolve(first.item, first.request);
    const forged = WorkItem.Info.parse({
      ...first.item,
      revision: admission.recordedHead,
      completionFacts: {
        ...first.item.completionFacts,
        admissions: [admission],
      },
    });

    expect(() =>
      adapter.workItem.compareAndSet(first.item.workItemId, first.item.revision, forged),
    ).toThrow("WorkItem completion fact writes are restricted to the OpenOmni boundary");
    expect(WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions).toHaveLength(0);
  });

  test("refuses raw storage callers that inject trusted completion facts", async () => {
    const adapter = configure();
    const first = await fixture("external_actor");
    const forged = WorkItem.Info.parse({
      ...first.item,
      revision: first.item.revision + 1,
      completionFacts: {
        ...first.item.completionFacts,
        revision: first.item.completionFacts.revision + 1,
        claims: first.request.claims,
        observations: first.request.observations,
        results: first.request.results,
      },
    });

    expect(() =>
      adapter.workItem.compareAndSet(first.item.workItemId, first.item.revision, forged),
    ).toThrow("WorkItem completion fact writes are restricted to the OpenOmni boundary");
    expect(WorkItemStore.get(first.item.workItemId)?.completionFacts.results).toEqual([]);
  });

  test("persists admission before terminal state and links the terminal receipt", async () => {
    const adapter = configure();
    const { item, request, report } = await fixture();
    const candidates: WorkItem.Info[] = [];
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      candidates.push(candidate);
      return compareAndSet(hash, expectedHead, candidate);
    };
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const events = completionEvents(item.workItemId);

    await service.requestCompletion(request, report);
    await events.completed;

    const stored = WorkItemStore.get(item.workItemId);
    const admission = stored?.completionFacts.admissions[0];
    if (!stored || !admission) throw new Error("shape");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.completionFacts.admissions).toHaveLength(1);
    expect(candidates[0] ? WorkItem.deriveStatus(candidates[0]) : undefined).not.toBe("completed");
    expect(candidates[0]?.completionTerminalReceipt).toBeUndefined();
    expect(candidates[1] ? WorkItem.deriveStatus(candidates[1]) : undefined).toBe("completed");
    expect(events.order).toEqual([
      "CompletionRequested",
      "CompletionAdmissionRecorded",
      "CompletedV2",
    ]);
    expect(
      events.admissionStates[0] ? WorkItem.deriveStatus(events.admissionStates[0]) : undefined,
    ).not.toBe("completed");
    expect(stored?.completionTerminalReceipt).toEqual({
      version: 1,
      hash: item.workItemId,
      requestId: request.id,
      admissionId: admission?.id,
      contractRevision: item.completionContract.revision,
      basisRef: item.completionContract.basisRef,
      completionReportRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      recordedHead: stored?.revision,
    });
  });

  test.each([
    "block",
    "escalate",
  ] as const)("persists a %s admission without completing", async (decision) => {
    configure();
    const { item, request, report } = await fixture();
    const admissionAuthority = authority([decision]);
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const events = completionEvents(item.workItemId);

    await service.requestCompletion(request, report);
    await events.admissionRecorded;

    const stored = WorkItemStore.get(item.workItemId);
    expect(stored?.completionFacts.admissions[0]?.decision).toBe(decision);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).not.toBe("completed");
    expect(stored?.completionTerminalReceipt).toBeUndefined();
    expect(events.order).toEqual(["CompletionRequested", "CompletionAdmissionRecorded"]);
  });

  test("rejects a terminal report with unresolved evidence after recording admission", async () => {
    configure();
    const { item, request, report } = await fixture();
    const service = guardedService(authority().resolver);
    if (!service) return;
    const missingEvidenceReport: WorkItem.CompletionReport = {
      ...report,
      claims: [{ statement: "criterion one", evidenceIds: ["evidence:missing"] }],
    };

    await expect(service.requestCompletion(request, missingEvidenceReport)).rejects.toThrow(
      "completion report references missing evidence",
    );

    const stored = WorkItemStore.get(item.workItemId);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).not.toBe("completed");
    expect(stored?.completionReport).toBeUndefined();
  });

  test("materializes one recovery blocker for an invalid recorded terminal report", async () => {
    configure();
    const { item, request, report } = await fixture();
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW,
    });
    const invalidReport: WorkItem.CompletionReport = {
      ...report,
      claims: report.claims.map((claim) => ({
        ...claim,
        evidenceIds: ["evidence:missing-on-recovery"],
      })),
    };

    await expect(
      gateway.requestCompletion(request, invalidReport, { traceId: "trace-test" }),
    ).rejects.toThrow("completion report references missing evidence");
    const admission = WorkItemStore.get(item.workItemId)?.completionFacts.admissions.at(-1);
    if (!admission) throw new Error("missing invalid-report admission");

    const receipt = await gateway.recoverRecordedCompletions("trace-test");
    const recovered = WorkItemStore.get(item.workItemId);
    expect(receipt).toEqual({ recovered: 1, skipped: 0, failures: [] });
    expect(recovered?.blockers).toHaveLength(1);
    expect(recovered?.blockers[0]?.id).toBe(`${admission.id}:recovery-blocker`);
    expect(recovered?.blockers[0]?.description).toContain(
      "completion report references missing evidence",
    );

    const replay = await gateway.recoverRecordedCompletions("trace-test");
    expect(replay).toEqual({ recovered: 0, skipped: 1, failures: [] });
    expect(WorkItemStore.get(item.workItemId)?.blockers).toHaveLength(1);
  });

  test("rejects a terminal report that cites failed evidence after recording admission", async () => {
    configure();
    const { item, request, report } = await fixture("worker", false);
    const service = guardedService(authority().resolver);
    if (!service) return;

    await expect(service.requestCompletion(request, report)).rejects.toThrow(
      "completion report references failed evidence",
    );

    const stored = WorkItemStore.get(item.workItemId);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).not.toBe("completed");
    expect(stored?.completionReport).toBeUndefined();
  });

  test("rejects a terminal report claim outside the admitted criterion graph", async () => {
    configure();
    const { item, request, report } = await fixture();
    const service = guardedService(authority().resolver);
    if (!service) return;
    const unrelatedReport: WorkItem.CompletionReport = {
      ...report,
      claims: [
        {
          statement: "An unrelated deployment claim.",
          evidenceIds: report.claims[0]?.evidenceIds ?? [],
        },
      ],
    };

    await expect(service.requestCompletion(request, unrelatedReport)).rejects.toThrow(
      "completion report claim is not admitted",
    );

    const stored = WorkItemStore.get(item.workItemId);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).not.toBe("completed");
    expect(stored?.completionReport).toBeUndefined();
  });

  test("rejects evidence reachable only through a non-effective refuted result", async () => {
    configure();
    const first = await fixture();
    const withEvidence = await WorkItemStore.addEvidence(
      first.item.workItemId,
      {
        kind: "verification",
        description: "passing artifact attached to a refuted result",
        passed: true,
      },
      "trace-test",
    );
    const refutedEvidenceId = withEvidence?.evidence.at(-1)?.id;
    if (!withEvidence || !refutedEvidenceId) throw new Error("missing refuted-result evidence");
    const verifiedResult = first.request.results[0];
    const verifiedClaim = first.request.claims[0];
    if (!verifiedResult || !verifiedClaim) throw new Error("missing verified fixture facts");
    const refutedObservationId = "observation:refuted-current-basis";
    const candidate = WorkItem.CompletionRequest.parse({
      ...first.request,
      expectedHead: withEvidence.revision,
      claims: [
        ...first.request.claims,
        {
          ...verifiedClaim,
          id: "claim:refuted-current-basis",
          observationIds: [refutedObservationId],
        },
      ],
      observations: [
        ...first.request.observations,
        {
          id: refutedObservationId,
          producer: "builtin:refuted",
          subjectRef: withEvidence.workItemId,
          basisRef: withEvidence.completionContract.basisRef,
          artifactRefs: [refutedEvidenceId],
          provenanceRef: refutedEvidenceId,
          ancestryRefs: [],
          observedAt: NOW,
        },
      ],
      results: [
        ...first.request.results,
        {
          ...verifiedResult,
          id: "result:refuted-current-basis",
          value: "refuted",
          observationIds: [refutedObservationId],
        },
      ],
    });
    const resolver = {
      resolve(currentInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
        const current = WorkItem.Info.parse(currentInput);
        const request = WorkItem.CompletionRequest.parse(requestInput);
        return admissionFrom(current, request, {
          id: `admission:${request.id}:${current.revision + 1}:verified-only`,
          effectiveResultIds: [verifiedResult.id],
          policyRef: "policy:verified-only",
        });
      },
    };
    const service = guardedService(resolver);
    if (!service) return;
    const report: WorkItem.CompletionReport = {
      ...first.report,
      claims: [
        {
          statement: verifiedClaim.statement,
          evidenceIds: [refutedEvidenceId],
        },
      ],
    };

    await expect(service.requestCompletion(candidate, report)).rejects.toThrow(
      "completion report evidence is not admitted",
    );
    expect(WorkItemStore.get(first.item.workItemId)?.completionTerminalReceipt).toBeUndefined();
  });

  test("canonicalizes report evidence order before admission and terminal linkage", async () => {
    configure();
    const first = await fixture();
    const withSecondEvidence = await WorkItemStore.addEvidence(
      first.item.workItemId,
      {
        kind: "verification",
        description: "second terminal artifact",
        passed: true,
      },
      "trace-test",
    );
    const secondEvidenceId = withSecondEvidence?.evidence.at(-1)?.id;
    const firstEvidenceId = first.report.claims[0]?.evidenceIds[0];
    if (!withSecondEvidence || !secondEvidenceId || !firstEvidenceId) {
      throw new Error("missing report ordering fixture");
    }
    const request = WorkItem.CompletionRequest.parse({
      ...first.request,
      expectedHead: withSecondEvidence.revision,
      observations: first.request.observations.map((observation) => ({
        ...observation,
        artifactRefs: [secondEvidenceId, firstEvidenceId],
      })),
    });
    const report: WorkItem.CompletionReport = {
      ...first.report,
      claims: first.report.claims.map((claim) => ({
        ...claim,
        evidenceIds: [secondEvidenceId, firstEvidenceId],
      })),
    };
    const service = guardedService(authority().resolver);
    if (!service) return;

    const outcome = await service.requestCompletion(request, report);
    const stored = WorkItemStore.get(first.item.workItemId);
    const expectedEvidenceIds = [firstEvidenceId, secondEvidenceId].sort();

    expect(field(outcome, "completed")).toBe(true);
    expect(stored?.completionReport?.claims[0]?.evidenceIds).toEqual(expectedEvidenceIds);
    expect(
      stored?.completionFacts.admissions[0]?.completionReportSnapshot?.claims[0]?.evidenceIds,
    ).toEqual(expectedEvidenceIds);
  });

  test("rejects a hostile admission id colliding with a proposed fact", async () => {
    configure();
    const first = await fixture();
    const collisionId = first.item.completionFacts.criteria[0]?.id;
    if (!collisionId) throw new Error("missing collision fixture");
    const service = guardedService({
      resolve(itemInput: unknown, requestInput: unknown) {
        const item = WorkItem.Info.parse(itemInput);
        const request = WorkItem.CompletionRequest.parse(requestInput);
        return admissionFrom(item, request, {
          id: collisionId,
          policyRef: "policy:collision",
        });
      },
    });
    if (!service) return;

    await expect(service.requestCompletion(first.request, first.report)).rejects.toThrow(
      "completion request conflicts with durable facts",
    );
    const stored = WorkItemStore.get(first.item.workItemId);
    expect(stored?.completionFacts.admissions).toEqual([]);
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });

  test("rejects a hostile admit with unresolved required criteria before terminal commit", async () => {
    configure();
    const { item, request, report } = await fixture();
    const hostileResolver = {
      resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
        const current = WorkItem.Info.parse(itemInput);
        const candidate = WorkItem.CompletionRequest.parse(requestInput);
        return {
          version: 1,
          id: `admission:${candidate.id}:${current.revision + 1}:hostile-unresolved`,
          requestId: candidate.id,
          ...admissionIdentity(candidate),
          origin: candidate.origin,
          contractRevision: current.completionContract.revision,
          basisRef: current.completionContract.basisRef,
          effectiveResultIds: candidate.results.map(({ id }) => id),
          unresolvedCriterionIds: current.completionFacts.criteria.map(({ id }) => id),
          decision: "admit",
          reasonCodes: [],
          residualRisks: [],
          policyRef: "policy:hostile-unresolved",
          expectedHead: current.revision,
          recordedHead: current.revision + 1,
          createdAt: NOW,
        } as WorkItem.CompletionAdmission;
      },
    };
    const service = guardedService(hostileResolver);
    if (!service) return;
    const events = completionEvents(item.workItemId);

    await expect(service.requestCompletion(request, report)).rejects.toMatchObject({
      name: "ZodError",
    });
    events.stop();

    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
    expect(WorkItemStore.get(item.workItemId)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
    expect(events.order).not.toContain("CompletedV2");
  });

  test("rejects a nonterminal admission with an unknown unresolved criterion", async () => {
    configure();
    const { item, request, report } = await fixture();
    const service = guardedService({
      resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
        const current = WorkItem.Info.parse(itemInput);
        const candidate = WorkItem.CompletionRequest.parse(requestInput);
        return admissionFrom(current, candidate, {
          id: `admission:${candidate.id}:${current.revision + 1}:unknown-criterion`,
          effectiveResultIds: [],
          unresolvedCriterionIds: ["criterion:missing"],
          decision: "block",
          reasonCodes: ["criterion_missing"],
          policyRef: "policy:hostile-unknown-criterion",
        });
      },
    });
    if (!service) return;

    expect(await errorCode(service.requestCompletion(request, report))).toBe("request_conflict");
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
  });

  test("rejects a nonterminal admission with a missing effective result", async () => {
    configure();
    const { item, request, report } = await fixture();
    const service = guardedService({
      resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
        const current = WorkItem.Info.parse(itemInput);
        const candidate = WorkItem.CompletionRequest.parse(requestInput);
        return admissionFrom(current, candidate, {
          id: `admission:${candidate.id}:${current.revision + 1}:missing-result`,
          effectiveResultIds: ["result:missing"],
          unresolvedCriterionIds: [current.completionFacts.criteria[0]?.id],
          decision: "block",
          reasonCodes: ["result_missing"],
          policyRef: "policy:hostile-missing-result",
        });
      },
    });
    if (!service) return;

    expect(await errorCode(service.requestCompletion(request, report))).toBe("request_conflict");
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
  });

  test("rejects a hostile admit that selects a refuted result", async () => {
    configure();
    const { item, request, report } = await fixture();
    const refutedRequest = WorkItem.CompletionRequest.parse({
      ...request,
      results: request.results.map((result) => ({ ...result, value: "refuted" })),
    });
    const service = guardedService({
      resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
        const current = WorkItem.Info.parse(itemInput);
        const candidate = WorkItem.CompletionRequest.parse(requestInput);
        return admissionFrom(current, candidate, {
          id: `admission:${candidate.id}:${current.revision + 1}:hostile-refuted`,
          policyRef: "policy:hostile-refuted",
        });
      },
    });
    if (!service) return;

    expect(await errorCode(service.requestCompletion(refutedRequest, report))).toBe(
      "request_conflict",
    );
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
  });

  test("rejects a hostile admission that mutates the authenticated sourceIdentity", async () => {
    configure();
    const first = await fixture("external_actor");
    const request = WorkItem.CompletionRequest.parse({
      ...first.request,
      sourceIdentity: {
        source: "api",
        identity: { kind: "external_actor", id: "actor:authenticated" },
      },
    });
    const service = guardedService({
      resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
        const current = WorkItem.Info.parse(itemInput);
        const candidate = WorkItem.CompletionRequest.parse(requestInput);
        return admissionFrom(current, candidate, {
          id: `admission:${candidate.id}:${current.revision + 1}:hostile-source-identity`,
          sourceIdentity: {
            source: "api",
            identity: { kind: "external_actor", id: "actor:forged" },
          },
          policyRef: "policy:hostile-source-identity",
        });
      },
    });
    if (!service) return;

    expect(await errorCode(service.requestCompletion(request, first.report))).toBe(
      "request_conflict",
    );
    expect(WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions).toEqual([]);
    expect(WorkItemStore.get(first.item.workItemId)?.completionTerminalReceipt).toBeUndefined();
  });

  test("normalizes authority failure while resume re-evaluates a newer head", async () => {
    configure();
    const { item, request, report } = await fixture("recovery");
    const blockingService = guardedService(blockingAuthority());
    if (!blockingService) return;
    await blockingService.requestCompletion(request, report);
    const admissionId = WorkItemStore.get(item.workItemId)?.completionFacts.admissions[0]?.id;
    if (!admissionId) throw new Error("missing blocking admission");
    await advanceHead(item.workItemId, "mutated before recovery re-evaluation");
    const unavailableService = guardedService({
      resolve() {
        throw new Error("authority backend unavailable");
      },
    });
    if (!unavailableService) return;

    const code = await errorCode(
      unavailableService.resumeCompletion(item.workItemId, admissionId, report),
    );

    expect(code).toBe("authority_unavailable");
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
  });

  test("preserves deterministic fold errors as unsupported completion facts", async () => {
    configure();
    const { item, request, report } = await fixture("worker");
    const observation = request.observations[0];
    if (!observation) throw new Error("missing proposed observation");
    const gateway = createWorkItemCompletionGateway({
      completionWriter,
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW,
    });

    const code = await errorCode(
      gateway.requestCompletion(
        WorkItem.CompletionRequest.parse({
          ...request,
          observations: [{ ...observation, ancestryRefs: ["observation:missing"] }],
        }),
        report,
        { traceId: "trace-test" },
      ),
    );

    expect(code).toBe("unsupported_fact");
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
  });

  test.each([
    [
      "invalidation",
      {
        invalidations: [
          {
            id: "invalidation:hostile-boundary",
            resultId: "result:durable-refuted",
            basisRef: "basis:v1",
            reason: "claimant wants a refutation ignored",
            createdAt: NOW,
          },
        ],
      },
    ],
    [
      "effect settlement",
      {
        effects: [
          {
            id: "effect:hostile-boundary",
            attempt: 1,
            intentRef: "intent:publish",
            outcome: "confirmed",
            createdAt: NOW,
          },
        ],
      },
    ],
  ] as const)("rejects requester-supplied %s before a custom resolver can admit it", async (_name, proposedFacts) => {
    configure();
    const { item, request, report } = await fixture();
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const hostileRequest = WorkItem.CompletionRequest.parse({
      ...request,
      ...proposedFacts,
      ...("invalidations" in proposedFacts
        ? {
            invalidations: proposedFacts.invalidations.map((invalidation) => ({
              ...invalidation,
              basisRef: item.completionContract.basisRef,
            })),
          }
        : {}),
    });
    const before = WorkItemStore.get(item.workItemId);

    const code = await errorCode(service.requestCompletion(hostileRequest, report));

    expect(code).toBe("unsupported_fact");
    expect(admissionAuthority.calls).toEqual([]);
    expect(WorkItemStore.get(item.workItemId)).toEqual(before);
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
  });

  test.each([
    "failed",
    "cancelled",
  ] as const)("rejects an initially %s WorkItem before authority or durable completion output", async (terminalStatus) => {
    configure();
    const { item, request, report } = await fixture();
    if (terminalStatus === "failed") {
      await WorkItemStore.fail(item.workItemId, "trace-test", "terminal before completion request");
    } else {
      await WorkItemStore.cancel(item.workItemId, "trace-test");
    }
    const before = WorkItemStore.get(item.workItemId);
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const events = completionEvents(item.workItemId);

    const code = await errorCode(service.requestCompletion(request, report));
    events.stop();

    expect(code).toBe("terminal_state");
    expect(admissionAuthority.calls).toEqual([]);
    expect(WorkItemStore.get(item.workItemId)).toEqual(before);
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
    expect(WorkItemStore.get(item.workItemId)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
    expect(events.order).not.toContain("CompletedV2");
  });

  test("rejects an initial stale_basis without appending", async () => {
    configure();
    const { item, request, report } = await fixture();
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const before = WorkItemStore.get(item.workItemId);

    const code = await errorCode(
      service.requestCompletion(
        WorkItem.CompletionRequest.parse({ ...request, basisRef: "basis:stale" }),
        report,
      ),
    );

    expect(code).toBe("stale_basis");
    expect(WorkItemStore.get(item.workItemId)).toEqual(before);
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
  });

  test("re-evaluates an initial stale_head against the current row", async () => {
    configure();
    const { item, request, report } = await fixture();
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;

    const outcome = await service.requestCompletion(
      WorkItem.CompletionRequest.parse({ ...request, expectedHead: 0 }),
      report,
    );
    const stored = WorkItemStore.get(item.workItemId);

    expect(field(outcome, "completed")).toBe(true);
    expect(admissionAuthority.calls).toEqual([
      {
        itemHead: item.revision,
        requestHead: item.revision,
        requestId: request.id,
      },
    ]);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
  });

  test("resumes one filesystem SQLite admission after restart with its original id", async () => {
    const dbPath = join(tmpdir(), `openomni-490-t6-${process.pid}.sqlite`);
    databasePaths.push(dbPath);
    removeDatabase(dbPath);
    const firstAdapter = configure(dbPath);
    const { item, request, report } = await fixture("recovery");
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const compareAndSet = firstAdapter.workItem.compareAndSet.bind(firstAdapter.workItem);
    let writeCount = 0;
    class SimulatedCrashError extends Error {}
    firstAdapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      writeCount += 1;
      if (writeCount === 2) throw new SimulatedCrashError("crash after admission");
      return compareAndSet(hash, expectedHead, candidate);
    };
    const admissionEvent = completionEvents(item.workItemId);

    await expect(service.requestCompletion(request, report)).rejects.toBeInstanceOf(
      SimulatedCrashError,
    );
    await admissionEvent.admissionRecorded;
    const originalAdmissionId = WorkItemStore.get(item.workItemId)?.completionFacts.admissions[0]
      ?.id;
    expect(originalAdmissionId).toBeString();
    closeAdapter(firstAdapter);
    Storage.reset();

    configure(dbPath);
    const resumedService = guardedService(authority().resolver);
    if (!resumedService || !originalAdmissionId) return;
    const completionEvent = completionEvents(item.workItemId);
    await resumedService.resumeCompletion(item.workItemId, originalAdmissionId, report);
    await completionEvent.completed;

    const stored = WorkItemStore.get(item.workItemId);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("completed");
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored?.completionFacts.admissions[0]?.id).toBe(originalAdmissionId);
    expect(stored?.completionTerminalReceipt?.admissionId).toBe(originalAdmissionId);
    expect(completionEvent.order).toEqual(["CompletedV2"]);
  });

  test("rejects a changed report when resuming an admitted request", async () => {
    configure();
    const { item, request, report } = await fixture("recovery");
    const service = guardedService(authority().resolver);
    if (!service) return;
    const reportWithMissingEvidence: WorkItem.CompletionReport = {
      ...report,
      claims: [{ statement: "criterion one", evidenceIds: ["evidence:missing"] }],
    };
    await expect(service.requestCompletion(request, reportWithMissingEvidence)).rejects.toThrow(
      "completion report references missing evidence",
    );
    const admissionId = WorkItemStore.get(item.workItemId)?.completionFacts.admissions[0]?.id;
    if (!admissionId) throw new Error("missing admitted completion");
    const beforeResume = WorkItemStore.get(item.workItemId);

    const code = await errorCode(service.resumeCompletion(item.workItemId, admissionId, report));

    expect(code).toBe("request_conflict");
    expect(WorkItemStore.get(item.workItemId)).toEqual(beforeResume);
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
  });

  test.each([
    "failed",
    "cancelled",
  ] as const)("rejects resume of an admitted request after the WorkItem becomes %s", async (terminalStatus) => {
    configure();
    const { item, request, report } = await fixture("recovery");
    const service = guardedService(authority().resolver);
    if (!service) return;
    const invalidReport: WorkItem.CompletionReport = {
      ...report,
      claims: [{ statement: "criterion one", evidenceIds: ["evidence:missing"] }],
    };
    await expect(service.requestCompletion(request, invalidReport)).rejects.toThrow(
      "completion report references missing evidence",
    );
    const admissionId = WorkItemStore.get(item.workItemId)?.completionFacts.admissions[0]?.id;
    if (!admissionId) throw new Error("missing admitted completion");
    if (terminalStatus === "failed") {
      await WorkItemStore.fail(item.workItemId, "trace-test", "terminal before completion resume");
    } else {
      await WorkItemStore.cancel(item.workItemId, "trace-test");
    }
    const before = WorkItemStore.get(item.workItemId);
    const events = completionEvents(item.workItemId);

    const code = await errorCode(service.resumeCompletion(item.workItemId, admissionId, report));
    events.stop();

    expect(code).toBe("terminal_state");
    expect(WorkItemStore.get(item.workItemId)).toEqual(before);
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(item.workItemId)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
    expect(events.order).not.toContain("CompletedV2");
  });

  test("requires a fresh Owner override receipt when resume re-evaluates at a newer head", async () => {
    const adapter = configure();
    const { item, request, report } = await fixture("recovery");
    const ownerOverrideReceiptRef = "owner-override:receipt:restart";
    const requestWithOverride = WorkItem.CompletionRequest.parse({
      ...request,
      origin: "resident",
      sourceIdentity: {
        source: "resident",
        identity: { kind: "resident", id: "resident:primary" },
      },
      ownerOverrideReceiptRef,
    });
    const observedReceiptRefs: Array<string | undefined> = [];
    const ownerAuthority = {
      resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
        const current = WorkItem.Info.parse(itemInput);
        const candidate = WorkItem.CompletionRequest.parse(requestInput);
        observedReceiptRefs.push(candidate.ownerOverrideReceiptRef);
        const hasOwnerReceipt = candidate.ownerOverrideReceiptRef === ownerOverrideReceiptRef;
        return admissionFrom(current, candidate, {
          id: `admission:${candidate.id}:${current.revision + 1}:owner-recovery`,
          effectiveResultIds: hasOwnerReceipt ? candidate.results.map(({ id }) => id) : [],
          unresolvedCriterionIds: hasOwnerReceipt
            ? []
            : current.completionFacts.criteria.map(({ id }) => id),
          decision: hasOwnerReceipt ? "owner_override" : "block",
          reasonCodes: hasOwnerReceipt ? [] : ["owner_override_receipt_missing"],
          policyRef: "policy:owner-recovery",
          ...(hasOwnerReceipt ? { ownerOverrideReceiptRef } : {}),
        });
      },
    };
    const service = guardedService(ownerAuthority);
    if (!service) return;
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    let writeCount = 0;
    class SimulatedCrashError extends Error {}
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      writeCount += 1;
      if (writeCount === 2) throw new SimulatedCrashError("crash after Owner admission");
      return compareAndSet(hash, expectedHead, candidate);
    };

    await expect(service.requestCompletion(requestWithOverride, report)).rejects.toBeInstanceOf(
      SimulatedCrashError,
    );
    adapter.workItem.compareAndSet = compareAndSet;
    const originalAdmissionId = WorkItemStore.get(item.workItemId)?.completionFacts.admissions[0]
      ?.id;
    if (!originalAdmissionId) throw new Error("missing Owner admission");
    await advanceHead(item.workItemId, "advanced before Owner resume");
    const resumedService = guardedService(ownerAuthority);
    if (!resumedService) return;

    await resumedService.resumeCompletion(item.workItemId, originalAdmissionId, report);

    const stored = WorkItemStore.get(item.workItemId);
    expect(observedReceiptRefs).toEqual([ownerOverrideReceiptRef, undefined]);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("pending");
    expect(stored?.completionFacts.admissions).toHaveLength(2);
    expect(stored?.completionFacts.admissions[1]).toMatchObject({ decision: "block" });
    expect(stored?.completionFacts.admissions[1]?.sourceIdentity).toEqual(
      requestWithOverride.sourceIdentity,
    );
    expect(stored?.completionFacts.admissions[1]?.ownerOverrideReceiptRef).toBeUndefined();
    expect(stored?.completionTerminalReceipt).toBeUndefined();
  });

  test.each([
    "block",
    "escalate",
  ] as const)("re-evaluates a stale %s admission after the WorkItem head advances", async (firstDecision) => {
    configure();
    const first = await fixture("replay");
    const admissionAuthority = authority([firstDecision, "admit"]);
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;

    await service.requestCompletion(first.request, first.report);
    const firstRecorded = WorkItemStore.get(first.item.workItemId);
    if (!firstRecorded) throw new Error("missing first recorded admission");
    await advanceHead(first.item.workItemId, "head advanced after blocked admission");
    const advanced = WorkItemStore.get(first.item.workItemId);
    if (!advanced) throw new Error("missing advanced WorkItem");

    const replay = await service.requestCompletion(first.request, first.report);

    expect(admissionAuthority.calls).toEqual([
      {
        itemHead: first.item.revision,
        requestHead: first.request.expectedHead,
        requestId: first.request.id,
      },
      {
        itemHead: advanced.revision,
        requestHead: advanced.revision,
        requestId: first.request.id,
      },
    ]);
    expect(Reflect.get(replay as object, "completed")).toBe(true);
    expect(WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions).toHaveLength(2);
    expect(WorkItemStore.get(first.item.workItemId)?.completionTerminalReceipt?.admissionId).toBe(
      WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions[1]?.id,
    );
  });

  test("rejects replay of one admission id when its proposed facts change", async () => {
    configure();
    const service = guardedService(blockingAuthority());
    if (!service) return;
    const first = await fixture("replay");
    await service.requestCompletion(first.request, first.report);
    const recorded = WorkItemStore.get(first.item.workItemId);
    if (!recorded) throw new Error("missing recorded admission");
    const originalResult = first.request.results[0];
    if (!originalResult) throw new Error("missing original proposed result");
    const changedResultId = `${originalResult.id}:changed`;
    const changedRequest = WorkItem.CompletionRequest.parse({
      ...first.request,
      results: [
        {
          ...originalResult,
          id: changedResultId,
          checkedPredicate: "changed predicate must not be silently dropped",
        },
      ],
    });
    const beforeReplay = WorkItemStore.get(first.item.workItemId);

    const code = await errorCode(service.requestCompletion(changedRequest, first.report));

    expect(code).toBeString();
    expect(code).not.toBe("stale_head");
    expect(WorkItemStore.get(first.item.workItemId)).toEqual(beforeReplay);
    expect(
      WorkItemStore.get(first.item.workItemId)?.completionFacts.results.some(
        ({ id }) => id === changedResultId,
      ),
    ).toBe(false);
    expect(WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions).toHaveLength(1);
  });

  test.each([
    "observations",
    "results",
  ] as const)("rejects replay when the %s array removes a proposed fact", async (removedField) => {
    configure();
    const first = await fixture("replay");
    const criterion = first.item.completionFacts.criteria[0];
    if (!criterion) throw new Error("missing replay criterion");
    const fullRequest = WorkItem.CompletionRequest.parse({
      ...first.request,
      ownerOverrideReceiptRef: "owner-receipt:replay",
      observations: [
        {
          id: `observation:${first.item.workItemId}:replay`,
          producer: "verifier:replay",
          subjectRef: first.item.workItemId,
          basisRef: first.item.completionContract.basisRef,
          artifactRefs: [],
          ancestryRefs: [],
          observedAt: NOW,
        },
      ],
      results: [
        {
          ...first.request.results[0],
          criterionId: criterion.id,
        },
      ],
    });
    const service = guardedService(blockingAuthority());
    if (!service) return;
    await service.requestCompletion(fullRequest, first.report);
    const beforeReplay = WorkItemStore.get(first.item.workItemId);
    const partialRequest = WorkItem.CompletionRequest.parse({
      ...fullRequest,
      [removedField]: [],
    });

    const code = await errorCode(service.requestCompletion(partialRequest, first.report));

    expect(code).toBe("request_conflict");
    expect(WorkItemStore.get(first.item.workItemId)).toEqual(beforeReplay);
    expect(WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions).toHaveLength(1);
  });

  test("rejects replay when the Owner override receipt candidate changes", async () => {
    configure();
    const first = await fixture("replay");
    const originalRequest = WorkItem.CompletionRequest.parse({
      ...first.request,
      ownerOverrideReceiptRef: "owner-receipt:original",
    });
    const service = guardedService(blockingAuthority());
    if (!service) return;
    await service.requestCompletion(originalRequest, first.report);
    const beforeReplay = WorkItemStore.get(first.item.workItemId);
    const changedRequest = WorkItem.CompletionRequest.parse({
      ...originalRequest,
      ownerOverrideReceiptRef: "owner-receipt:changed",
    });

    const code = await errorCode(service.requestCompletion(changedRequest, first.report));

    expect(code).toBe("request_conflict");
    expect(WorkItemStore.get(first.item.workItemId)).toEqual(beforeReplay);
  });

  test("canonicalizes top-level facts and nested set-like references for replay identity", async () => {
    configure();
    const first = await fixture("replay");
    const originalResult = first.request.results[0];
    if (!originalResult) throw new Error("missing canonical replay result");
    const observations: WorkItem.Observation[] = ["a", "b"].map((suffix) => ({
      id: `observation:${first.item.workItemId}:${suffix}`,
      producer: "verifier:replay",
      subjectRef: first.item.workItemId,
      basisRef: first.item.completionContract.basisRef,
      artifactRefs: [`artifact:${suffix}:b`, `artifact:${suffix}:a`],
      ancestryRefs: [`ancestor:${suffix}:b`, `ancestor:${suffix}:a`],
      observedAt: NOW,
    }));
    const observationIds = observations.map(({ id }) => id);
    const claims: WorkItem.Claim[] = [
      {
        id: `claim:${first.item.workItemId}:nested-replay`,
        criterionId: originalResult.criterionId,
        statement: "nested replay references are set-like",
        observationIds: [...observationIds].reverse(),
        basisRef: first.item.completionContract.basisRef,
        createdAt: NOW,
      },
    ];
    const results = ["a", "b"].map((suffix) => ({
      ...originalResult,
      id: `${originalResult.id}:${suffix}`,
      observationIds: [...observationIds].reverse(),
      assumptions: [`assumption:${suffix}:b`, `assumption:${suffix}:a`],
      residualRisks: [`risk:${suffix}:b`, `risk:${suffix}:a`],
    }));
    const originalRequest = WorkItem.CompletionRequest.parse({
      ...first.request,
      claims,
      observations,
      results,
    });
    const service = guardedService(blockingAuthority());
    if (!service) return;
    await service.requestCompletion(originalRequest, first.report);
    const beforeReplay = WorkItemStore.get(first.item.workItemId);
    const reorderedRequest = Object.fromEntries(
      Object.entries({
        ...originalRequest,
        claims: claims.map((claim) => ({
          ...claim,
          observationIds: [...claim.observationIds].reverse().concat(claim.observationIds[0] ?? []),
        })),
        observations: [...observations].reverse().map((observation) => ({
          ...observation,
          artifactRefs: [...observation.artifactRefs]
            .reverse()
            .concat(observation.artifactRefs[0] ?? []),
          ancestryRefs: [...observation.ancestryRefs]
            .reverse()
            .concat(observation.ancestryRefs[0] ?? []),
        })),
        results: [...results].reverse().map((result) =>
          Object.fromEntries(
            Object.entries({
              ...result,
              observationIds: [...result.observationIds]
                .reverse()
                .concat(result.observationIds[0] ?? []),
              assumptions: [...result.assumptions].reverse().concat(result.assumptions[0] ?? []),
              residualRisks: [...result.residualRisks]
                .reverse()
                .concat(result.residualRisks[0] ?? []),
            }).reverse(),
          ),
        ),
      }).reverse(),
    ) as WorkItem.CompletionRequest;

    const replay = await service.requestCompletion(reorderedRequest, first.report);
    const changedMembership = WorkItem.CompletionRequest.parse({
      ...originalRequest,
      results: originalRequest.results.map((result, index) =>
        index === 0
          ? { ...result, assumptions: [...result.assumptions, "assumption:added"] }
          : result,
      ),
    });
    const changedMembershipCode = await errorCode(
      service.requestCompletion(changedMembership, first.report),
    );

    expect(replay).toMatchObject({ completed: false });
    expect(changedMembershipCode).toBe("request_conflict");
    expect(WorkItemStore.get(first.item.workItemId)).toEqual(beforeReplay);
    expect(
      WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions[0]?.proposedFactIds
        .observations,
    ).toEqual(observations.map(({ id }) => id).sort());
  });

  test("rejects a changed report when replaying a completed request", async () => {
    configure();
    const first = await fixture("replay");
    const service = guardedService(authority().resolver);
    if (!service) return;
    await service.requestCompletion(first.request, first.report);
    const completed = WorkItemStore.get(first.item.workItemId);

    await service.requestCompletion(first.request, first.report);
    const afterExactReplay = WorkItemStore.get(first.item.workItemId);
    const changedReport: WorkItem.CompletionReport = {
      ...first.report,
      summary: "Changed replay summary.",
    };
    const changedReportCode = await errorCode(
      service.requestCompletion(first.request, changedReport),
    );

    expect(afterExactReplay).toEqual(completed);
    expect(changedReportCode).toBe("request_conflict");
    expect(WorkItemStore.get(first.item.workItemId)).toEqual(completed);
  });

  test("keeps exact completed replay idempotent but rejects a new completion request id", async () => {
    configure();
    const first = await fixture("replay");
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    await service.requestCompletion(first.request, first.report);
    const completed = WorkItemStore.get(first.item.workItemId);
    if (!completed) throw new Error("missing completed WorkItem");
    const authorityCallsAfterCompletion = admissionAuthority.calls.length;

    const exactReplay = await service.requestCompletion(first.request, first.report);
    const newRequest = completionRequest(completed, "replay");
    const newRequestCode = await errorCode(service.requestCompletion(newRequest, first.report));

    expect(exactReplay).toMatchObject({ completed: true });
    expect(newRequestCode).toBe("terminal_state");
    expect(admissionAuthority.calls).toHaveLength(authorityCallsAfterCompletion);
    expect(WorkItemStore.get(first.item.workItemId)).toEqual(completed);
    expect(WorkItemStore.get(first.item.workItemId)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(first.item.workItemId)?.completionTerminalReceipt).toEqual(
      completed.completionTerminalReceipt,
    );
  });

  test("keeps reentrant replay from admission publication exactly terminal-once", async () => {
    configure();
    const first = await fixture("replay");
    const service = guardedService(authority().resolver);
    if (!service) return;
    let replay: ReturnType<typeof service.requestCompletion> | undefined;
    let completedEvents = 0;
    const stopAdmission = Bus.subscribe(WorkItem.Events.CompletionAdmissionRecorded, (event) => {
      if (event.payload.workItemId === first.item.workItemId && replay === undefined) {
        replay = service.requestCompletion(first.request, first.report);
      }
    });
    const stopCompleted = Bus.subscribe(WorkItem.Events.CompletedV2, (event) => {
      if (event.payload.hash === first.item.workItemId) completedEvents += 1;
    });

    const firstOutcome = await service.requestCompletion(first.request, first.report);
    const replayOutcome = await replay;
    stopAdmission();
    stopCompleted();
    const stored = WorkItemStore.get(first.item.workItemId);

    expect(field(firstOutcome, "completed")).toBe(true);
    if (replayOutcome === undefined) throw new Error("shape");
    expect(field(replayOutcome, "completed")).toBe(true);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored?.completionTerminalReceipt?.admissionId).toBe(
      stored?.completionFacts.admissions[0]?.id,
    );
    expect(completedEvents).toBe(1);
  });

  test("after admission B completes, replay is idempotent for B and refuses blocked A", async () => {
    configure();
    const admissionAuthority = authority(["block", "admit"]);
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const first = await fixture("replay");
    await service.requestCompletion(first.request, first.report);
    const blocked = WorkItemStore.get(first.item.workItemId);
    if (!blocked) throw new Error("missing blocked WorkItem");
    const secondRequest = completionRequest(blocked, "replay");
    const events = completionEvents(first.item.workItemId);

    await service.requestCompletion(secondRequest, first.report);
    await events.completed;
    const completed = WorkItemStore.get(first.item.workItemId);
    const blockedAdmissionId = completed?.completionFacts.admissions[0]?.id;
    const admittedId = completed?.completionFacts.admissions[1]?.id;
    if (!blockedAdmissionId || !admittedId) throw new Error("missing replay admissions");

    await service.resumeCompletion(first.item.workItemId, admittedId, first.report);
    const afterLinkedReplay = WorkItemStore.get(first.item.workItemId);
    const historicalAdmissionCode = await errorCode(
      service.resumeCompletion(first.item.workItemId, blockedAdmissionId, first.report),
    );

    expect(afterLinkedReplay).toEqual(completed);
    expect(events.order.filter((name) => name === "CompletedV2")).toHaveLength(1);
    expect(WorkItemStore.get(first.item.workItemId)?.completionTerminalReceipt?.admissionId).toBe(
      admittedId,
    );
    expect(historicalAdmissionCode).toBe("admission_required");
  });

  test("re-evaluates when the row head changes during authority resolution", async () => {
    configure();
    const { item, request, report } = await fixture();
    const baseAuthority = authority();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let authorityCalls = 0;
    const service = guardedService({
      async resolve(itemInput: unknown, requestInput: unknown) {
        authorityCalls += 1;
        if (authorityCalls === 1) {
          entered.resolve();
          await release.promise;
        }
        return baseAuthority.resolver.resolve(itemInput, requestInput);
      },
    });
    if (!service) return;

    const pending = service.requestCompletion(request, report);
    await entered.promise;
    await advanceHead(item.workItemId, "mutated during authority");
    release.resolve();
    const outcome = await pending;
    const stored = WorkItemStore.get(item.workItemId);

    expect(field(outcome, "completed")).toBe(true);
    expect(authorityCalls).toBe(2);
    expect(evidenceDescriptions(stored)).toContain("mutated during authority");
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored?.blockers).toEqual([]);
  });

  test("re-evaluates after terminal CAS contention and emits completion once", async () => {
    const adapter = configure();
    const { item, request, report } = await fixture();
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    let terminalContended = false;
    let completedEvents = 0;
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (!terminalContended && candidate.completionTerminalReceipt !== undefined) {
        terminalContended = true;
        const current = adapter.workItem.get(hash);
        if (!current) throw new Error("missing terminal contention WorkItem");
        const competitor = WorkItem.Info.parse({
          ...current,
          revision: current.revision + 1,
          name: "mutated during terminal CAS",
          timestamps: { ...current.timestamps, updated: current.timestamps.updated + 1 },
        });
        expect(compareAndSet(hash, expectedHead, competitor)).toBe(true);
        return false;
      }
      return compareAndSet(hash, expectedHead, candidate);
    };
    const stopCompleted = Bus.subscribe(WorkItem.Events.CompletedV2, (event) => {
      if (event.payload.hash === item.workItemId) completedEvents += 1;
    });

    const outcome = await service.requestCompletion(request, report);
    stopCompleted();
    const stored = WorkItemStore.get(item.workItemId);

    expect(field(outcome, "completed")).toBe(true);
    expect(terminalContended).toBe(true);
    expect(stored?.name).toBe("mutated during terminal CAS");
    expect(stored?.completionFacts.admissions).toHaveLength(2);
    expect(stored?.completionTerminalReceipt?.admissionId).toBe(
      stored?.completionFacts.admissions.at(-1)?.id,
    );
    expect(completedEvents).toBe(1);
    expect(stored?.blockers).toEqual([]);
  });

  test("bounds persistent admission CAS contention without durable output", async () => {
    configure();
    const { item, request, report } = await fixture();
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver, () => false);
    if (!service) return;

    const code = await errorCode(service.requestCompletion(request, report));

    expect(code).toBe("stale_head");
    expect(admissionAuthority.calls).toHaveLength(8);
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toEqual([]);
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
  });

  test("shares one retry budget with persistent reservation CAS contention", async () => {
    configure();
    const { item, request, report } = await fixture();
    let reservationWrites = 0;
    const service = guardedService(
      authority().resolver,
      () => {
        reservationWrites += 1;
        return false;
      },
      { ownerId: "process:contended", leaseDurationMs: 10 },
    );
    if (!service) return;

    expect(await errorCode(service.requestCompletion(request, report))).toBe("stale_head");
    expect(reservationWrites).toBe(8);
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.requestReservations).toEqual([]);
  });

  test("retries resume only after transient terminal stale-head contention", async () => {
    const adapter = configure();
    const { item, request, report } = await fixture("recovery");
    const service = guardedService(authority().resolver);
    if (!service) return;
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (candidate.completionTerminalReceipt !== undefined) {
        throw new Error("crash after admission before terminal completion");
      }
      return compareAndSet(hash, expectedHead, candidate);
    };
    await expect(service.requestCompletion(request, report)).rejects.toThrow(
      "crash after admission before terminal completion",
    );
    const admissionId = WorkItemStore.get(item.workItemId)?.completionFacts.admissions[0]?.id;
    if (!admissionId) throw new Error("missing recorded admission");
    let terminalContended = false;
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (!terminalContended && candidate.completionTerminalReceipt !== undefined) {
        terminalContended = true;
        const current = adapter.workItem.get(hash);
        if (!current) throw new Error("missing resume contention WorkItem");
        const competitor = WorkItem.Info.parse({
          ...current,
          revision: current.revision + 1,
          name: "head advanced during resume terminal CAS",
          timestamps: { ...current.timestamps, updated: current.timestamps.updated + 1 },
        });
        expect(compareAndSet(hash, expectedHead, competitor)).toBe(true);
        return false;
      }
      return compareAndSet(hash, expectedHead, candidate);
    };

    const resumed = await service.resumeCompletion(item.workItemId, admissionId, report);

    expect(terminalContended).toBe(true);
    expect(
      WorkItem.deriveStatus(WorkItem.Info.parse(Reflect.get(resumed as object, "workItem"))),
    ).toBe("completed");
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toHaveLength(2);
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt?.admissionId).toBe(
      WorkItemStore.get(item.workItemId)?.completionFacts.admissions.at(-1)?.id,
    );
  });

  test("re-evaluates at a new head when the row mutates after admission", async () => {
    configure();
    const { item, request, report } = await fixture();
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    let mutation: Promise<WorkItem.Info | undefined> | undefined;
    const events = completionEvents(item.workItemId, () => {
      mutation = advanceHead(item.workItemId, "mutated after admission");
    });

    await service.requestCompletion(request, report);
    await events.completed;
    await mutation;

    const stored = WorkItemStore.get(item.workItemId);
    expect(admissionAuthority.calls.map(({ itemHead }) => itemHead)).toEqual([
      item.revision,
      item.revision + 2,
    ]);
    expect(stored?.completionFacts.admissions).toHaveLength(2);
    expect(stored?.completionFacts.admissions[0]?.id).not.toBe(
      stored?.completionFacts.admissions[1]?.id,
    );
    expect(stored?.completionTerminalReceipt?.admissionId).toBe(
      stored?.completionFacts.admissions[1]?.id,
    );
    expect(evidenceDescriptions(stored)).toContain("mutated after admission");
  });

  test.each([
    "failed",
    "cancelled",
  ] as const)("rejects %s during re-evaluation without recording another admission", async (terminalStatus) => {
    configure();
    const { item, request, report } = await fixture();
    let callCount = 0;
    const recheckAuthority = authority();
    const resolver = {
      async resolve(
        itemInput: WorkItem.Info,
        requestInput: WorkItem.CompletionRequest,
      ): Promise<WorkItem.CompletionAdmission> {
        callCount += 1;
        if (callCount === 2) {
          if (terminalStatus === "failed") {
            await WorkItemStore.fail(
              item.workItemId,
              "trace-test",
              "terminal during completion re-evaluation",
            );
          } else {
            await WorkItemStore.cancel(item.workItemId, "trace-test");
          }
        }
        return recheckAuthority.resolver.resolve(itemInput, requestInput);
      },
    };
    const service = guardedService(resolver);
    if (!service) return;
    let mutation: Promise<WorkItem.Info | undefined> | undefined;
    const events = completionEvents(item.workItemId, () => {
      mutation = advanceHead(item.workItemId, "force completion re-evaluation");
    });

    const code = await errorCode(service.requestCompletion(request, report));
    await mutation;
    events.stop();

    expect(code).toBe("terminal_state");
    expect(callCount).toBe(2);
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(item.workItemId)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
    expect(events.order).not.toContain("CompletedV2");
  });

  test.each([
    "failed",
    "cancelled",
  ] as const)("re-reads and rejects %s immediately before terminal compare-and-set", async (terminalStatus) => {
    const adapter = configure();
    const { item, request, report } = await fixture();
    const service = guardedService(authority().resolver);
    if (!service) return;
    const originalGet = adapter.workItem.get.bind(adapter.workItem);
    const originalCompareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    let postAdmissionReads = 0;
    adapter.workItem.get = (hash) => {
      const current = originalGet(hash);
      if (
        current?.completionFacts.admissions.length === 1 &&
        current.completionTerminalReceipt === undefined
      ) {
        postAdmissionReads += 1;
        if (postAdmissionReads === 2) {
          const terminal = WorkItem.Info.parse({
            ...current,
            revision: current.revision + 1,
            timestamps: {
              ...current.timestamps,
              [terminalStatus]: NOW + 1,
              updated: NOW + 1,
            },
            ...(terminalStatus === "failed"
              ? { failureReason: "terminal immediately before completion CAS" }
              : {}),
          });
          expect(originalCompareAndSet(hash, current.revision, terminal)).toBe(true);
          return originalGet(hash);
        }
      }
      return current;
    };
    let completedEvents = 0;
    const stop = Bus.subscribe(WorkItem.Events.CompletedV2, (event) => {
      if (event.payload.hash === item.workItemId) completedEvents += 1;
    });

    const code = await errorCode(service.requestCompletion(request, report));
    stop();

    expect(code).toBe("terminal_state");
    expect(postAdmissionReads).toBe(2);
    expect(WorkItemStore.get(item.workItemId)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(item.workItemId)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.workItemId)?.completionTerminalReceipt).toBeUndefined();
    expect(completedEvents).toBe(0);
  });

  test("returns typed admission_required when resume has no prior admission", async () => {
    configure();
    const { item, report } = await fixture("recovery");
    const service = guardedService(authority().resolver);
    if (!service) return;
    const before = WorkItemStore.get(item.workItemId);

    const code = await errorCode(
      service.resumeCompletion(item.workItemId, "admission:missing", report),
    );

    expect(code).toBe("admission_required");
    expect(WorkItemStore.get(item.workItemId)).toEqual(before);
  });
});
