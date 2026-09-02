// allow: SIZE_OK — one writer contract suite shares the same transactional fixture.
import { afterEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { Storage } from "../../src/storage/storage";
import { WorkItemAttemptRun } from "../../src/work-item/attempt-run";
import { WorkItemStore } from "../../src/work-item";
import { verificationFactsShapeViolation } from "../../src/work-item/verification-facts";

const adapters: SqliteStorageAdapter[] = [];

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("fixture value missing");
  return value;
}

function attemptIdentity(workInput: string) {
  return {
    contentFingerprint: WorkItem.contentFingerprintOf({
      workInput,
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true, reason: "test fixture" },
      model: {
        provider: "test",
        id: "test",
        parameters: { absent: true, reason: "test fixture" },
      },
      upstreamFingerprints: { absent: true, reason: "test fixture" },
      dependencyLock: { absent: true, reason: "test fixture" },
    }),
    environmentFingerprint: WorkItem.environmentFingerprintOf({
      os: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
      workspaceRoot: { absent: true, reason: "test fixture" },
      schemaVersions: { workItem: 1 },
      policy: { absent: true, reason: "test fixture" },
      toolVersions: { absent: true, reason: "test fixture" },
      verifierVersions: { absent: true, reason: "test fixture" },
      providerParameters: { absent: true, reason: "test fixture" },
      configRef: { absent: true, reason: "test fixture" },
    }),
  };
}

async function runningItem(): Promise<WorkItem.Info> {
  const adapter = new SqliteStorageAdapter(":memory:");
  adapters.push(adapter);
  Storage.configure(adapter);
  const created = await WorkItemStore.create(
    {
      name: "verification facts",
      sourceMessageId: "delegation-807",
      sourceChannel: "delegation",
      intent: "verify",
      goal: "verify",
      acceptanceCriteria: ["build passes"],
      sessionId: "session-807",
    },
    "trace-create",
  );
  await WorkItemStore.assignExecution(
    created.workItemId,
    {
      executorKind: "internal_chat_agent",
      workerRunId: "delegation-807",
      workSessionId: "session-807",
    },
    "trace-assign",
  );
  const allocated = await WorkItemStore.allocateAttempt(
    created.workItemId,
    attemptIdentity("verify"),
    "trace-attempt",
  );
  if (allocated === undefined) throw new Error("fixture attempt was not allocated");
  return allocated.item;
}

function inputFor(item: WorkItem.Info) {
  const criterion = item.completionFacts.criteria[0];
  if (criterion === undefined) throw new Error("fixture criterion missing");
  const attemptId = item.currentAttemptId;
  if (attemptId === undefined) throw new Error("fixture attempt identity missing");
  const basisRef = item.completionContract.basisRef;
  const evidenceId = "evidence:verifier:delegation-807:criterion-0";
  const observationId = "observation:verifier:delegation-807:criterion-0";
  return {
    expectedAttempt: item.lastAttemptSeq,
    expectedAttemptId: attemptId,
    expectedBasisRef: basisRef,
    observations: [
      {
        id: observationId,
        producer: "verifier:command.v1",
        subjectRef: item.workItemId,
        basisRef,
        artifactRefs: [evidenceId],
        provenanceRef: evidenceId,
        ancestryRefs: [`attempt:${attemptId}`],
        observedAt: 1_000,
      },
    ],
    results: [
      {
        id: "result:verifier:delegation-807:criterion-0",
        criterionId: criterion.id,
        value: "verified" as const,
        checkedPredicate: "command.v1:bun:argv:exit=0",
        observationIds: [observationId],
        verifierRef: "verifier:command.v1:delegation-807",
        assumptions: [],
        basisRef,
        residualRisks: [],
        createdAt: 1_000,
      },
    ],
    verificationErrors: [],
    evidence: [
      {
        id: evidenceId,
        kind: "verification" as const,
        criterionId: criterion.id,
        description: "command.v1 bun: exit 0 (expected 0)",
        passed: true,
        detail: "{}",
      },
    ],
    verifierRef: "verifier:command.v1:delegation-807",
  };
}

afterEach(() => {
  Storage.reset();
  for (const adapter of adapters.splice(0)) adapter.close();
});

describe("WorkItemStore.appendVerificationFacts", () => {
  test("the shape guard rejects seven foreign projection mutations", async () => {
    const item = await runningItem();
    const baseline = WorkItem.Info.parse({
      ...item,
      revision: item.revision + 1,
      completionFacts: { ...item.completionFacts, revision: item.completionFacts.revision + 1 },
      timestamps: { ...item.timestamps, updated: item.timestamps.updated + 1 },
    });
    const mutations: readonly WorkItem.Info[] = [
      { ...baseline, name: "forbidden" },
      { ...baseline, intent: "forbidden" },
      { ...baseline, goal: "forbidden" },
      { ...baseline, constraints: ["forbidden"] },
      { ...baseline, completionContract: { ...item.completionContract, basisRef: "forbidden" } },
      { ...baseline, failureReason: "forbidden" },
      { ...baseline, timestamps: { ...baseline.timestamps, created: 2 } },
    ];

    expect(verificationFactsShapeViolation(item, baseline)).toBe(false);
    expect(mutations.every((candidate) => verificationFactsShapeViolation(item, candidate))).toBe(
      true,
    );
  });

  test("appends only verifier facts and records the transition fact before projection", async () => {
    const item = await runningItem();

    const outcome = WorkItemStore.appendVerificationFacts(item.workItemId, inputFor(item), "trace");

    expect(outcome).toEqual({ kind: "appended", revision: item.revision + 1 });
    const recorded = WorkItemStore.get(item.workItemId);
    expect(recorded?.completionFacts.results.map((fact) => fact.id)).toEqual([
      "result:verifier:delegation-807:criterion-0",
    ]);
    expect(recorded?.evidence[0]).toMatchObject({
      attempt: item.attempt,
      basisRef: item.completionContract.basisRef,
      createdAt: expect.any(Number),
    });
    expect(Storage.get().ledger?.headFact(`work:${item.workItemId}`)).toMatchObject({
      type: "work_item.verification_recorded",
      seq: item.revision + 1,
    });
  });

  test("refuses stale attempt and stale basis without writing", async () => {
    const item = await runningItem();
    const input = inputFor(item);

    const staleAttempt = WorkItemStore.appendVerificationFacts(
      item.workItemId,
      { ...input, expectedAttempt: item.attempt + 1 },
      "trace",
    );
    const staleAttemptId = WorkItemStore.appendVerificationFacts(
      item.workItemId,
      { ...input, expectedAttemptId: "attempt-stale" },
      "trace",
    );
    const staleBasis = WorkItemStore.appendVerificationFacts(
      item.workItemId,
      { ...input, expectedBasisRef: "stale:basis" },
      "trace",
    );

    expect(staleAttempt).toEqual({ kind: "refused", reason: "stale_attempt" });
    expect(staleAttemptId).toEqual({ kind: "refused", reason: "stale_attempt" });
    expect(staleBasis).toEqual({ kind: "refused", reason: "stale_basis" });
    expect(WorkItemStore.get(item.workItemId)?.revision).toBe(item.revision);
  });

  test("refuses attempt-one facts after attempt two becomes active", async () => {
    // Given: verification began on attempt one, then a retry became current.
    const firstAttempt = await runningItem();
    const staleInput = inputFor(firstAttempt);
    const secondAllocation = await WorkItemStore.allocateAttempt(
      firstAttempt.workItemId,
      attemptIdentity("verify again"),
      "trace-retry",
    );
    if (secondAllocation === undefined) throw new Error("fixture retry was not allocated");

    // When: the attempt-one verifier tries to commit after attempt two allocation.
    const outcome = WorkItemStore.appendVerificationFacts(
      firstAttempt.workItemId,
      staleInput,
      "trace-stale",
    );

    // Then: legacy Info.attempt remains one, but the active watermark refuses the stale write.
    expect(secondAllocation.item.attempt).toBe(1);
    expect(secondAllocation.item.lastAttemptSeq).toBe(2);
    expect(outcome).toEqual({ kind: "refused", reason: "stale_attempt" });
    expect(WorkItemStore.get(firstAttempt.workItemId)?.completionFacts.results).toEqual([]);
  });

  test("refuses a closed attempt without writing verification facts", async () => {
    const item = await runningItem();
    await WorkItemAttemptRun.finish("session-807", "delegation-807", "unverified", "trace-close", {
      endedAt: 2_000,
    });

    const outcome = WorkItemStore.appendVerificationFacts(item.workItemId, inputFor(item), "trace");

    expect(outcome).toEqual({ kind: "refused", reason: "attempt_closed" });
  });

  test("is exactly idempotent and rejects partial or conflicting identities", async () => {
    const item = await runningItem();
    const input = inputFor(item);
    expect(WorkItemStore.appendVerificationFacts(item.workItemId, input, "trace").kind).toBe(
      "appended",
    );

    const duplicate = WorkItemStore.appendVerificationFacts(item.workItemId, input, "trace");
    const conflict = WorkItemStore.appendVerificationFacts(
      item.workItemId,
      {
        ...input,
        results: [{ ...first(input.results), checkedPredicate: "different" }],
      },
      "trace",
    );

    expect(duplicate).toEqual({ kind: "already_recorded" });
    expect(conflict).toEqual({ kind: "refused", reason: "identity_conflict" });
  });

  test("fails closed on foreign subjects and bases", async () => {
    const item = await runningItem();
    const input = inputFor(item);

    const foreignSubject = WorkItemStore.appendVerificationFacts(
      item.workItemId,
      { ...input, observations: [{ ...first(input.observations), subjectRef: "other-item" }] },
      "trace",
    );
    const foreignBasis = WorkItemStore.appendVerificationFacts(
      item.workItemId,
      { ...input, results: [{ ...first(input.results), basisRef: "other-basis" }] },
      "trace",
    );

    expect(foreignSubject).toEqual({ kind: "refused", reason: "forbidden_shape" });
    expect(foreignBasis).toEqual({ kind: "refused", reason: "forbidden_shape" });
  });

  test("the raw adapter still refuses completion-fact writes outside the authority", async () => {
    const item = await runningItem();
    const adapter = Storage.get().workItem;
    if (adapter === undefined) throw new Error("fixture adapter missing");
    const input = inputFor(item);
    const result = first(input.results);

    expect(() =>
      adapter.compareAndSet(item.workItemId, item.revision, {
        ...item,
        revision: item.revision + 1,
        completionFacts: {
          ...item.completionFacts,
          revision: item.completionFacts.revision + 1,
          results: [...item.completionFacts.results, result],
        },
      }),
    ).toThrow("restricted to the OpenOmni boundary");
  });
});
