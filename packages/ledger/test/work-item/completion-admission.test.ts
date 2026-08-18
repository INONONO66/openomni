import { afterEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage.js";
import { Storage } from "../../src/storage/storage.js";
import { WorkItemStore } from "../../src/work-item/index.js";

const adapters: SqliteStorageAdapter[] = [];
const completionWriters = new WeakMap<SqliteStorageAdapter, Storage.WorkItemCompletionWriter>();

function configure(): SqliteStorageAdapter {
  const adapter = new SqliteStorageAdapter(":memory:");
  adapters.push(adapter);
  completionWriters.set(adapter, Storage.configure(adapter));
  return adapter;
}

function authorizedCompareAndSet(
  adapter: SqliteStorageAdapter,
  hash: string,
  expectedHead: number,
  candidate: WorkItem.Info,
): boolean {
  const completionWriter = completionWriters.get(adapter);
  if (!completionWriter) throw new Error("missing completion writer");
  return completionWriter(hash, expectedHead, candidate);
}

async function createItem() {
  return WorkItemStore.create(
    {
      name: "Admission persistence",
      sourceMessageId: "msg_admission",
      sourceChannel: "test",
      intent: "complete",
      goal: "record before close",
      acceptanceCriteria: ["criterion one"],
    },
    "trace-test",
  );
}

function admissionCandidate(
  item: WorkItem.Info,
  decision: WorkItem.CompletionDecision = "admit",
): WorkItem.Info {
  const criterion = item.completionFacts.criteria[0];
  if (!criterion) throw new Error("missing stable criterion");
  const result = WorkItem.CriterionResult.parse({
    id: `result:${item.workItemId}:${item.revision}`,
    criterionId: criterion.id,
    value: "verified",
    checkedPredicate: criterion.statement,
    observationIds: [],
    verifierRef: "verifier:test",
    assumptions: [],
    basisRef: item.completionContract.basisRef,
    residualRisks: [],
    createdAt: item.timestamps.updated + 1,
  });
  const requestId = `completion-request:${item.workItemId}:${item.revision}`;
  const admission = WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${item.workItemId}:${item.revision + 1}:${decision}`,
    requestId,
    workItemHash: item.workItemId,
    origin: "worker",
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    requestRoot: "request-root:session-admission",
    proposedFactIds: {
      claims: [],
      observations: [],
      results: [result.id],
      invalidations: [],
      verificationErrors: [],
      effects: [],
    },
    effectiveResultIds: decision === "admit" ? [result.id] : [],
    unresolvedCriterionIds: decision === "admit" ? [] : [criterion.id],
    decision,
    reasonCodes: decision === "admit" ? [] : [`completion_${decision}`],
    residualRisks: [],
    policyRef: "policy:test",
    expectedHead: item.revision,
    recordedHead: item.revision + 1,
    createdAt: item.timestamps.updated + 1,
  });
  return WorkItem.Info.parse({
    ...item,
    revision: item.revision + 1,
    completionFacts: {
      ...item.completionFacts,
      revision: item.completionFacts.revision + 1,
      results: [...item.completionFacts.results, result],
      admissions: [...item.completionFacts.admissions, admission],
    },
    timestamps: { ...item.timestamps, updated: admission.createdAt },
  });
}

afterEach(() => {
  Storage.reset();
  for (const adapter of adapters.splice(0)) adapter.close();
});

describe("WorkItemStore completion admission storage boundary", () => {
  test("creates a unique contract and stable criteria from strings", async () => {
    configure();
    const first = await createItem();
    const second = await createItem();

    expect(first.completionContract).toEqual({
      version: 1,
      revision: "1",
      basisRef: `${first.workItemId}:attempt:1`,
    });
    expect(first.completionContract.basisRef).not.toBe(second.completionContract.basisRef);
    expect(first.completionFacts).toEqual({
      ...WorkItem.emptyCompletionFacts(),
      criteria: [
        {
          id: WorkItem.criterionId(first.workItemId, 0, "criterion one"),
          revision: 1,
          statement: "criterion one",
          required: true,
        },
      ],
    });
  });

  test("persists admission facts atomically through row compare-and-set", async () => {
    const adapter = configure();
    const item = await createItem();
    const candidate = admissionCandidate(item);

    const recorded = authorizedCompareAndSet(adapter, item.workItemId, item.revision, candidate);

    expect(recorded).toBe(true);
    expect(adapter.workItem.get(item.workItemId)?.revision).toBe(item.revision + 1);
    expect(adapter.workItem.get(item.workItemId)?.completionFacts.revision).toBe(1);
    expect(adapter.workItem.get(item.workItemId)?.completionFacts.criteria).toHaveLength(1);
    expect(adapter.workItem.get(item.workItemId)?.completionFacts.results).toHaveLength(1);
    expect(adapter.workItem.get(item.workItemId)?.completionFacts.admissions[0]?.decision).toBe(
      "admit",
    );
  });

  test("rejects stale compare-and-set without appending any fact", async () => {
    const adapter = configure();
    const item = await createItem();
    const first = admissionCandidate(item);
    expect(authorizedCompareAndSet(adapter, item.workItemId, item.revision, first)).toBe(true);
    const stale = admissionCandidate(item, "block");

    const recorded = authorizedCompareAndSet(adapter, item.workItemId, item.revision, stale);

    expect(recorded).toBe(false);
    expect(adapter.workItem.get(item.workItemId)?.completionFacts.admissions).toHaveLength(1);
    expect(adapter.workItem.get(item.workItemId)?.completionFacts.admissions[0]?.id).toBe(
      first.completionFacts.admissions[0]?.id,
    );
  });

  test("uses the shared WorkItem row revision after an ordinary mutation", async () => {
    const adapter = configure();
    const item = await createItem();
    const mutated = await WorkItemStore.addEvidence(
      item.workItemId,
      {
        kind: "verification",
        description: "ordinary mutation",
        passed: true,
      },
      "trace-test",
    );
    if (!mutated) throw new Error("missing mutated item");
    const candidate = admissionCandidate(mutated);

    const recorded = authorizedCompareAndSet(adapter, item.workItemId, mutated.revision, candidate);

    expect(mutated).toMatchObject({ revision: 2 });
    expect(mutated.completionFacts.revision).toBe(0);
    expect(recorded).toBe(true);
    expect(adapter.workItem.get(item.workItemId)).toMatchObject({ revision: 3 });
    expect(adapter.workItem.get(item.workItemId)?.completionFacts.admissions).toHaveLength(1);
  });

  test("does not expose completion mutation methods from WorkItemStore", () => {
    expect(Reflect.get(WorkItemStore, "appendCompletionAdmission")).toBeUndefined();
    expect(Reflect.get(WorkItemStore, "completeWithAdmission")).toBeUndefined();
    // #606: the raw complete() tombstone (it only threw admission_required)
    // is deleted outright — completion is reachable ONLY through the
    // admission writer returned by Storage.configure.
    expect(Reflect.get(WorkItemStore, "complete")).toBeUndefined();
  });
});
