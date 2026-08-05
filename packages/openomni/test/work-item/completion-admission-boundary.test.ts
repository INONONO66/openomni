import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolicyEngine } from "@openomni/policy";
import { WorkItem } from "@openomni/protocol";
import { Bus, SqliteStorageAdapter, Storage, WorkItemStore } from "@openomni/session";
import * as OpenOmni from "../../src/index.js";
import { createCompletionAdmissionService } from "../../src/work-item/completion-admission-boundary.js";
import { createWorkItemCompletionGateway } from "../../src/work-item/completion-gateway.js";
import * as WorkItemPublic from "../../src/work-item/index.js";

const NOW = 1_000;
const adapters: SqliteStorageAdapter[] = [];
const databasePaths: string[] = [];

function configure(dbPath = ":memory:"): SqliteStorageAdapter {
  const adapter = new SqliteStorageAdapter(dbPath);
  adapters.push(adapter);
  Storage.configure(adapter);
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
        return WorkItem.CompletionAdmission.parse({
          version: 1,
          id: `admission:${request.id}:${item.revision + 1}:${decisionIndex}`,
          requestId: request.id,
          requestSnapshot: request,
          origin: request.origin,
          contractRevision: item.completionContract.revision,
          basisRef: item.completionContract.basisRef,
          effectiveResultIds:
            decision === "admit"
              ? [...item.completionFacts.results, ...request.results].map(({ id }) => id)
              : [],
          unresolvedCriterionIds:
            decision === "admit" ? [] : item.completionFacts.criteria.map(({ id }) => id),
          decision,
          reasonCodes: decision === "admit" ? [] : [`completion_${decision}`],
          residualRisks: [],
          policyRef: "policy:test",
          expectedHead: item.revision,
          recordedHead: item.revision + 1,
          createdAt: NOW,
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
      return WorkItem.CompletionAdmission.parse({
        version: 1,
        id: `admission:${request.id}:${item.revision + 1}:block`,
        requestId: request.id,
        requestSnapshot: request,
        origin: request.origin,
        contractRevision: item.completionContract.revision,
        basisRef: item.completionContract.basisRef,
        effectiveResultIds: [],
        unresolvedCriterionIds: item.completionFacts.criteria.map(({ id }) => id),
        decision: "block",
        reasonCodes: ["completion_block"],
        residualRisks: [],
        policyRef: "policy:test",
        expectedHead: item.revision,
        recordedHead: item.revision + 1,
        createdAt: NOW,
      });
    },
  };
}

function guardedService(authorityResolver: unknown) {
  const service = Reflect.apply(createCompletionAdmissionService, undefined, [
    { authorityResolver, now: () => NOW },
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
      return Reflect.apply(requestCompletion, service, [request, report]);
    },
    resumeCompletion(
      hash: string,
      admissionId: string,
      report: WorkItem.CompletionReport,
    ): Promise<unknown> {
      return Reflect.apply(resumeCompletion, service, [hash, admissionId, report]);
    },
  };
}

async function fixture(origin: WorkItem.CompletionOrigin = "worker", evidencePassed = true) {
  const item = await WorkItemStore.create({
    name: `Admission ${origin}`,
    sourceMessageId: `msg_${origin}`,
    sourceChannel: "test",
    intent: "complete",
    goal: "close through one boundary",
    acceptanceCriteria: ["criterion one"],
  });
  const withEvidence = await WorkItemStore.addEvidence(item.hash, {
    kind: "verification",
    description: "boundary fixture",
    passed: evidencePassed,
  });
  const current = WorkItemStore.get(item.hash);
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
  const observationId = `observation:${item.hash}:${item.revision}`;
  return WorkItem.CompletionRequest.parse({
    version: 1,
    id: `completion-request:${item.hash}:${item.revision}:${origin}`,
    origin,
    workItemHash: item.hash,
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    expectedHead: item.revision,
    claims: [
      {
        id: `claim:${item.hash}:${item.revision}`,
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
        subjectRef: item.hash,
        basisRef: item.completionContract.basisRef,
        artifactRefs: [evidenceId],
        provenanceRef: evidenceId,
        ancestryRefs: [],
        observedAt: NOW,
      },
    ],
    results: [
      {
        id: `result:${item.hash}:${item.revision}`,
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
  let resolveAdmission = () => undefined;
  let resolveCompleted = () => undefined;
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
      if (event.payload.hash !== hash) return;
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

afterEach(() => {
  Bus.reset();
  Storage.reset();
  for (const adapter of adapters.splice(0)) adapter.close();
  for (const path of databasePaths.splice(0)) removeDatabase(path);
});

describe("WorkItem completion admission service", () => {
  test("uses one kernel-internal guarded completion gateway for non-Worker origins", async () => {
    configure();
    expect(Reflect.get(OpenOmni, "createWorkItemCompletionGateway")).toBeUndefined();
    expect(Reflect.get(OpenOmni, "createCompletionAdmissionService")).toBeUndefined();
    expect(Reflect.get(OpenOmni, "createCompletionAuthorityResolver")).toBeUndefined();
    const first = await fixture("external_actor");
    const trustedResult = first.request.results[0];
    if (!trustedResult) throw new Error("missing public gateway result");
    const gateway = createWorkItemCompletionGateway({
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: {
        validate(candidate: unknown) {
          const result = Reflect.get(candidate as object, "result");
          return { ok: WorkItem.CriterionResult.safeParse(result).success };
        },
      },
      now: () => NOW,
    });

    const outcome = await gateway.requestCompletion(first.request, first.report);

    expect(Reflect.get(outcome, "completed")).toBe(true);
    expect(WorkItemStore.get(first.item.hash)?.completionTerminalReceipt?.admissionId).toBe(
      WorkItemStore.get(first.item.hash)?.completionFacts.admissions[0]?.id,
    );
  });

  test("keeps the configurable gateway private while recovering recorded admissions", async () => {
    expect(Reflect.get(OpenOmni, "createWorkItemCompletionGateway")).toBeUndefined();
    expect(Reflect.get(WorkItemPublic, "createWorkItemCompletionGateway")).toBeUndefined();
    const adapter = configure();
    const first = await fixture("recovery");
    const gateway = createWorkItemCompletionGateway({
      policyEngine: PolicyEngine.create(),
      resultAuthorityPort: { validate: () => ({ ok: true }) },
      now: () => NOW,
    });
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    let writeCount = 0;
    class SimulatedBootCrash extends Error {}
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate, writerCapability) => {
      writeCount += 1;
      if (writeCount === 2) throw new SimulatedBootCrash("crash before terminal append");
      return compareAndSet(hash, expectedHead, candidate, writerCapability);
    };

    await expect(gateway.requestCompletion(first.request, first.report)).rejects.toBeInstanceOf(
      SimulatedBootCrash,
    );
    adapter.workItem.compareAndSet = compareAndSet;

    const receipt = await gateway.recoverRecordedCompletions();

    expect(receipt).toEqual({
      recovered: 1,
      skipped: 0,
      failures: [],
    });
    const recovered = WorkItemStore.get(first.item.hash);
    if (!recovered) throw new Error("missing recovered WorkItem");
    expect(WorkItem.deriveStatus(recovered)).toBe("completed");
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
      const events = completionEvents(item.hash);

      await service.requestCompletion(request, report);
      await events.completed;
      events.stop();

      const stored = WorkItemStore.get(item.hash);
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
      adapter.workItem.compareAndSet(first.item.hash, first.item.revision, forged),
    ).toThrow("WorkItem completion fact writes are restricted to the OpenOmni boundary");
    expect(WorkItemStore.get(first.item.hash)?.completionFacts.admissions).toHaveLength(0);
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
      adapter.workItem.compareAndSet(first.item.hash, first.item.revision, forged),
    ).toThrow("WorkItem completion fact writes are restricted to the OpenOmni boundary");
    expect(WorkItemStore.get(first.item.hash)?.completionFacts.results).toEqual([]);
  });

  test("persists admission before terminal state and links the terminal receipt", async () => {
    const adapter = configure();
    const { item, request, report } = await fixture();
    const candidates: WorkItem.Info[] = [];
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate, writerCapability) => {
      candidates.push(candidate);
      return compareAndSet(hash, expectedHead, candidate, writerCapability);
    };
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const events = completionEvents(item.hash);

    await service.requestCompletion(request, report);
    await events.completed;

    const stored = WorkItemStore.get(item.hash);
    const admission = stored?.completionFacts.admissions[0];
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
      hash: item.hash,
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
    const events = completionEvents(item.hash);

    await service.requestCompletion(request, report);
    await events.admissionRecorded;

    const stored = WorkItemStore.get(item.hash);
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

    const stored = WorkItemStore.get(item.hash);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).not.toBe("completed");
    expect(stored?.completionReport).toBeUndefined();
  });

  test("rejects a terminal report that cites failed evidence after recording admission", async () => {
    configure();
    const { item, request, report } = await fixture("worker", false);
    const service = guardedService(authority().resolver);
    if (!service) return;

    await expect(service.requestCompletion(request, report)).rejects.toThrow(
      "completion report references failed evidence",
    );

    const stored = WorkItemStore.get(item.hash);
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

    const stored = WorkItemStore.get(item.hash);
    expect(stored?.completionFacts.admissions).toHaveLength(1);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).not.toBe("completed");
    expect(stored?.completionReport).toBeUndefined();
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
          requestSnapshot: candidate,
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
    const events = completionEvents(item.hash);

    const code = await errorCode(service.requestCompletion(request, report));
    events.stop();

    expect(code).toBe("admission_required");
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toEqual([]);
    expect(WorkItemStore.get(item.hash)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.hash)?.completionTerminalReceipt).toBeUndefined();
    expect(events.order).not.toContain("CompletedV2");
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
    const before = WorkItemStore.get(item.hash);

    const code = await errorCode(service.requestCompletion(hostileRequest, report));

    expect(code).toBe("unsupported_fact");
    expect(admissionAuthority.calls).toEqual([]);
    expect(WorkItemStore.get(item.hash)).toEqual(before);
    expect(WorkItemStore.get(item.hash)?.completionTerminalReceipt).toBeUndefined();
  });

  test.each([
    "failed",
    "cancelled",
  ] as const)("rejects an initially %s WorkItem before authority or durable completion output", async (terminalStatus) => {
    configure();
    const { item, request, report } = await fixture();
    if (terminalStatus === "failed") {
      await WorkItemStore.fail(item.hash, "terminal before completion request");
    } else {
      await WorkItemStore.cancel(item.hash);
    }
    const before = WorkItemStore.get(item.hash);
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const events = completionEvents(item.hash);

    const code = await errorCode(service.requestCompletion(request, report));
    events.stop();

    expect(code).toBe("terminal_state");
    expect(admissionAuthority.calls).toEqual([]);
    expect(WorkItemStore.get(item.hash)).toEqual(before);
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toEqual([]);
    expect(WorkItemStore.get(item.hash)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.hash)?.completionTerminalReceipt).toBeUndefined();
    expect(events.order).not.toContain("CompletedV2");
  });

  test.each([
    ["stale_head", (request: WorkItem.CompletionRequest) => ({ ...request, expectedHead: 0 })],
    [
      "stale_basis",
      (request: WorkItem.CompletionRequest) => ({ ...request, basisRef: "basis:stale" }),
    ],
  ] as const)("rejects an initial %s without appending", async (expectedCode, mutateRequest) => {
    configure();
    const { item, request, report } = await fixture();
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const before = WorkItemStore.get(item.hash);

    const code = await errorCode(
      service.requestCompletion(WorkItem.CompletionRequest.parse(mutateRequest(request)), report),
    );

    expect(code).toBe(expectedCode);
    expect(WorkItemStore.get(item.hash)).toEqual(before);
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toEqual([]);
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
    firstAdapter.workItem.compareAndSet = (hash, expectedHead, candidate, writerCapability) => {
      writeCount += 1;
      if (writeCount === 2) throw new SimulatedCrashError("crash after admission");
      return compareAndSet(hash, expectedHead, candidate, writerCapability);
    };
    const admissionEvent = completionEvents(item.hash);

    await expect(service.requestCompletion(request, report)).rejects.toBeInstanceOf(
      SimulatedCrashError,
    );
    await admissionEvent.admissionRecorded;
    const originalAdmissionId = WorkItemStore.get(item.hash)?.completionFacts.admissions[0]?.id;
    expect(originalAdmissionId).toBeString();
    closeAdapter(firstAdapter);
    Storage.reset();

    configure(dbPath);
    const resumedService = guardedService(authority().resolver);
    if (!resumedService || !originalAdmissionId) return;
    const completionEvent = completionEvents(item.hash);
    await resumedService.resumeCompletion(item.hash, originalAdmissionId, report);
    await completionEvent.completed;

    const stored = WorkItemStore.get(item.hash);
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
    const admissionId = WorkItemStore.get(item.hash)?.completionFacts.admissions[0]?.id;
    if (!admissionId) throw new Error("missing admitted completion");
    const beforeResume = WorkItemStore.get(item.hash);

    const code = await errorCode(service.resumeCompletion(item.hash, admissionId, report));

    expect(code).toBe("request_conflict");
    expect(WorkItemStore.get(item.hash)).toEqual(beforeResume);
    expect(WorkItemStore.get(item.hash)?.completionTerminalReceipt).toBeUndefined();
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
    const admissionId = WorkItemStore.get(item.hash)?.completionFacts.admissions[0]?.id;
    if (!admissionId) throw new Error("missing admitted completion");
    if (terminalStatus === "failed") {
      await WorkItemStore.fail(item.hash, "terminal before completion resume");
    } else {
      await WorkItemStore.cancel(item.hash);
    }
    const before = WorkItemStore.get(item.hash);
    const events = completionEvents(item.hash);

    const code = await errorCode(service.resumeCompletion(item.hash, admissionId, report));
    events.stop();

    expect(code).toBe("terminal_state");
    expect(WorkItemStore.get(item.hash)).toEqual(before);
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(item.hash)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.hash)?.completionTerminalReceipt).toBeUndefined();
    expect(events.order).not.toContain("CompletedV2");
  });

  test("requires a fresh Owner override receipt when resume re-evaluates at a newer head", async () => {
    const adapter = configure();
    const { item, request, report } = await fixture("recovery");
    const ownerOverrideReceiptRef = "owner-override:receipt:restart";
    const requestWithOverride = WorkItem.CompletionRequest.parse({
      ...request,
      ownerOverrideReceiptRef,
    });
    const observedReceiptRefs: Array<string | undefined> = [];
    const ownerAuthority = {
      resolve(itemInput: unknown, requestInput: unknown): WorkItem.CompletionAdmission {
        const current = WorkItem.Info.parse(itemInput);
        const candidate = WorkItem.CompletionRequest.parse(requestInput);
        observedReceiptRefs.push(candidate.ownerOverrideReceiptRef);
        const hasOwnerReceipt = candidate.ownerOverrideReceiptRef === ownerOverrideReceiptRef;
        return WorkItem.CompletionAdmission.parse({
          version: 1,
          id: `admission:${candidate.id}:${current.revision + 1}:owner-recovery`,
          requestId: candidate.id,
          requestSnapshot: candidate,
          origin: candidate.origin,
          contractRevision: current.completionContract.revision,
          basisRef: current.completionContract.basisRef,
          effectiveResultIds: hasOwnerReceipt ? candidate.results.map(({ id }) => id) : [],
          unresolvedCriterionIds: hasOwnerReceipt
            ? []
            : current.completionFacts.criteria.map(({ id }) => id),
          decision: hasOwnerReceipt ? "owner_override" : "block",
          reasonCodes: hasOwnerReceipt ? [] : ["owner_override_receipt_missing"],
          residualRisks: [],
          policyRef: "policy:owner-recovery",
          ...(hasOwnerReceipt ? { ownerOverrideReceiptRef } : {}),
          expectedHead: current.revision,
          recordedHead: current.revision + 1,
          createdAt: NOW,
        });
      },
    };
    const service = guardedService(ownerAuthority);
    if (!service) return;
    const compareAndSet = adapter.workItem.compareAndSet.bind(adapter.workItem);
    let writeCount = 0;
    class SimulatedCrashError extends Error {}
    adapter.workItem.compareAndSet = (hash, expectedHead, candidate, writerCapability) => {
      writeCount += 1;
      if (writeCount === 2) throw new SimulatedCrashError("crash after Owner admission");
      return compareAndSet(hash, expectedHead, candidate, writerCapability);
    };

    await expect(service.requestCompletion(requestWithOverride, report)).rejects.toBeInstanceOf(
      SimulatedCrashError,
    );
    adapter.workItem.compareAndSet = compareAndSet;
    const originalAdmissionId = WorkItemStore.get(item.hash)?.completionFacts.admissions[0]?.id;
    if (!originalAdmissionId) throw new Error("missing Owner admission");
    await WorkItemStore.update(item.hash, { name: "advanced before Owner resume" });
    const resumedService = guardedService(ownerAuthority);
    if (!resumedService) return;

    await resumedService.resumeCompletion(item.hash, originalAdmissionId, report);

    const stored = WorkItemStore.get(item.hash);
    expect(observedReceiptRefs).toEqual([ownerOverrideReceiptRef, undefined]);
    expect(stored ? WorkItem.deriveStatus(stored) : undefined).toBe("pending");
    expect(stored?.completionFacts.admissions).toHaveLength(2);
    expect(stored?.completionFacts.admissions[1]).toMatchObject({ decision: "block" });
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
    const firstRecorded = WorkItemStore.get(first.item.hash);
    if (!firstRecorded) throw new Error("missing first recorded admission");
    await WorkItemStore.update(first.item.hash, { name: "head advanced after blocked admission" });
    const advanced = WorkItemStore.get(first.item.hash);
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
    expect(WorkItemStore.get(first.item.hash)?.completionFacts.admissions).toHaveLength(2);
    expect(WorkItemStore.get(first.item.hash)?.completionTerminalReceipt?.admissionId).toBe(
      WorkItemStore.get(first.item.hash)?.completionFacts.admissions[1]?.id,
    );
  });

  test("rejects replay of one admission id when its proposed facts change", async () => {
    configure();
    const service = guardedService(blockingAuthority());
    if (!service) return;
    const first = await fixture("replay");
    await service.requestCompletion(first.request, first.report);
    const recorded = WorkItemStore.get(first.item.hash);
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
    const beforeReplay = WorkItemStore.get(first.item.hash);

    const code = await errorCode(service.requestCompletion(changedRequest, first.report));

    expect(code).toBeString();
    expect(code).not.toBe("stale_head");
    expect(WorkItemStore.get(first.item.hash)).toEqual(beforeReplay);
    expect(
      WorkItemStore.get(first.item.hash)?.completionFacts.results.some(
        ({ id }) => id === changedResultId,
      ),
    ).toBe(false);
    expect(WorkItemStore.get(first.item.hash)?.completionFacts.admissions).toHaveLength(1);
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
          id: `observation:${first.item.hash}:replay`,
          producer: "verifier:replay",
          subjectRef: first.item.hash,
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
    const beforeReplay = WorkItemStore.get(first.item.hash);
    const partialRequest = WorkItem.CompletionRequest.parse({
      ...fullRequest,
      [removedField]: [],
    });

    const code = await errorCode(service.requestCompletion(partialRequest, first.report));

    expect(code).toBe("request_conflict");
    expect(WorkItemStore.get(first.item.hash)).toEqual(beforeReplay);
    expect(WorkItemStore.get(first.item.hash)?.completionFacts.admissions).toHaveLength(1);
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
    const beforeReplay = WorkItemStore.get(first.item.hash);
    const changedRequest = WorkItem.CompletionRequest.parse({
      ...originalRequest,
      ownerOverrideReceiptRef: "owner-receipt:changed",
    });

    const code = await errorCode(service.requestCompletion(changedRequest, first.report));

    expect(code).toBe("request_conflict");
    expect(WorkItemStore.get(first.item.hash)).toEqual(beforeReplay);
  });

  test("canonicalizes top-level facts and nested set-like references for replay identity", async () => {
    configure();
    const first = await fixture("replay");
    const originalResult = first.request.results[0];
    if (!originalResult) throw new Error("missing canonical replay result");
    const observations: WorkItem.Observation[] = ["a", "b"].map((suffix) => ({
      id: `observation:${first.item.hash}:${suffix}`,
      producer: "verifier:replay",
      subjectRef: first.item.hash,
      basisRef: first.item.completionContract.basisRef,
      artifactRefs: [`artifact:${suffix}:b`, `artifact:${suffix}:a`],
      ancestryRefs: [`ancestor:${suffix}:b`, `ancestor:${suffix}:a`],
      observedAt: NOW,
    }));
    const observationIds = observations.map(({ id }) => id);
    const claims: WorkItem.Claim[] = [
      {
        id: `claim:${first.item.hash}:nested-replay`,
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
    const beforeReplay = WorkItemStore.get(first.item.hash);
    const reorderedRequest = Object.fromEntries(
      Object.entries({
        ...originalRequest,
        claims: claims.map((claim) => ({
          ...claim,
          observationIds: [...claim.observationIds].reverse(),
        })),
        observations: [...observations].reverse().map((observation) => ({
          ...observation,
          artifactRefs: [...observation.artifactRefs].reverse(),
          ancestryRefs: [...observation.ancestryRefs].reverse(),
        })),
        results: [...results].reverse().map((result) =>
          Object.fromEntries(
            Object.entries({
              ...result,
              observationIds: [...result.observationIds].reverse(),
              assumptions: [...result.assumptions].reverse(),
              residualRisks: [...result.residualRisks].reverse(),
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
    expect(WorkItemStore.get(first.item.hash)).toEqual(beforeReplay);
    expect(
      WorkItemStore.get(
        first.item.hash,
      )?.completionFacts.admissions[0]?.requestSnapshot.observations.map(({ id }) => id),
    ).toEqual(observations.map(({ id }) => id).sort());
  });

  test("rejects a changed report when replaying a completed request", async () => {
    configure();
    const first = await fixture("replay");
    const service = guardedService(authority().resolver);
    if (!service) return;
    await service.requestCompletion(first.request, first.report);
    const completed = WorkItemStore.get(first.item.hash);

    await service.requestCompletion(first.request, first.report);
    const afterExactReplay = WorkItemStore.get(first.item.hash);
    const changedReport: WorkItem.CompletionReport = {
      ...first.report,
      summary: "Changed replay summary.",
    };
    const changedReportCode = await errorCode(
      service.requestCompletion(first.request, changedReport),
    );

    expect(afterExactReplay).toEqual(completed);
    expect(changedReportCode).toBe("request_conflict");
    expect(WorkItemStore.get(first.item.hash)).toEqual(completed);
  });

  test("keeps exact completed replay idempotent but rejects a new completion request id", async () => {
    configure();
    const first = await fixture("replay");
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    await service.requestCompletion(first.request, first.report);
    const completed = WorkItemStore.get(first.item.hash);
    if (!completed) throw new Error("missing completed WorkItem");
    const authorityCallsAfterCompletion = admissionAuthority.calls.length;

    const exactReplay = await service.requestCompletion(first.request, first.report);
    const newRequest = completionRequest(completed, "replay");
    const newRequestCode = await errorCode(service.requestCompletion(newRequest, first.report));

    expect(exactReplay).toMatchObject({ completed: true });
    expect(newRequestCode).toBe("terminal_state");
    expect(admissionAuthority.calls).toHaveLength(authorityCallsAfterCompletion);
    expect(WorkItemStore.get(first.item.hash)).toEqual(completed);
    expect(WorkItemStore.get(first.item.hash)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(first.item.hash)?.completionTerminalReceipt).toEqual(
      completed.completionTerminalReceipt,
    );
  });

  test("after admission B completes, replay is idempotent for B and refuses blocked A", async () => {
    configure();
    const admissionAuthority = authority(["block", "admit"]);
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    const first = await fixture("replay");
    await service.requestCompletion(first.request, first.report);
    const blocked = WorkItemStore.get(first.item.hash);
    if (!blocked) throw new Error("missing blocked WorkItem");
    const secondRequest = completionRequest(blocked, "replay");
    const events = completionEvents(first.item.hash);

    await service.requestCompletion(secondRequest, first.report);
    await events.completed;
    const completed = WorkItemStore.get(first.item.hash);
    const blockedAdmissionId = completed?.completionFacts.admissions[0]?.id;
    const admittedId = completed?.completionFacts.admissions[1]?.id;
    if (!blockedAdmissionId || !admittedId) throw new Error("missing replay admissions");

    await service.resumeCompletion(first.item.hash, admittedId, first.report);
    const afterLinkedReplay = WorkItemStore.get(first.item.hash);
    const historicalAdmissionCode = await errorCode(
      service.resumeCompletion(first.item.hash, blockedAdmissionId, first.report),
    );

    expect(afterLinkedReplay).toEqual(completed);
    expect(events.order.filter((name) => name === "CompletedV2")).toHaveLength(1);
    expect(WorkItemStore.get(first.item.hash)?.completionTerminalReceipt?.admissionId).toBe(
      admittedId,
    );
    expect(historicalAdmissionCode).toBe("admission_required");
  });

  test("re-evaluates at a new head when the row mutates after admission", async () => {
    configure();
    const { item, request, report } = await fixture();
    const admissionAuthority = authority();
    const service = guardedService(admissionAuthority.resolver);
    if (!service) return;
    let mutation: Promise<WorkItem.Info | undefined> | undefined;
    const events = completionEvents(item.hash, () => {
      mutation = WorkItemStore.update(item.hash, { name: "mutated after admission" });
    });

    await service.requestCompletion(request, report);
    await events.completed;
    await mutation;

    const stored = WorkItemStore.get(item.hash);
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
    expect(stored?.name).toBe("mutated after admission");
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
            await WorkItemStore.fail(item.hash, "terminal during completion re-evaluation");
          } else {
            await WorkItemStore.cancel(item.hash);
          }
        }
        return recheckAuthority.resolver.resolve(itemInput, requestInput);
      },
    };
    const service = guardedService(resolver);
    if (!service) return;
    let mutation: Promise<WorkItem.Info | undefined> | undefined;
    const events = completionEvents(item.hash, () => {
      mutation = WorkItemStore.update(item.hash, { name: "force completion re-evaluation" });
    });

    const code = await errorCode(service.requestCompletion(request, report));
    await mutation;
    events.stop();

    expect(code).toBe("terminal_state");
    expect(callCount).toBe(2);
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(item.hash)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.hash)?.completionTerminalReceipt).toBeUndefined();
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
      if (event.payload.hash === item.hash) completedEvents += 1;
    });

    const code = await errorCode(service.requestCompletion(request, report));
    stop();

    expect(code).toBe("terminal_state");
    expect(postAdmissionReads).toBe(2);
    expect(WorkItemStore.get(item.hash)?.completionFacts.admissions).toHaveLength(1);
    expect(WorkItemStore.get(item.hash)?.completionReport).toBeUndefined();
    expect(WorkItemStore.get(item.hash)?.completionTerminalReceipt).toBeUndefined();
    expect(completedEvents).toBe(0);
  });

  test("returns typed admission_required when resume has no prior admission", async () => {
    configure();
    const { item, report } = await fixture("recovery");
    const service = guardedService(authority().resolver);
    if (!service) return;
    const before = WorkItemStore.get(item.hash);

    const code = await errorCode(service.resumeCompletion(item.hash, "admission:missing", report));

    expect(code).toBe("admission_required");
    expect(WorkItemStore.get(item.hash)).toEqual(before);
  });
});
