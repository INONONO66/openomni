import { afterEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { SqliteStorageAdapter } from "../storage/sqlite-storage.js";
import { Storage } from "../storage/storage.js";
import { WorkItemStore } from "./index.js";

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
  return WorkItemStore.create({
    name: "Admission persistence",
    sourceMessageId: "msg_admission",
    sourceChannel: "test",
    intent: "complete",
    goal: "record before close",
    acceptanceCriteria: ["criterion one"],
  });
}

function admissionCandidate(
  item: WorkItem.Info,
  decision: WorkItem.CompletionDecision = "admit",
): WorkItem.Info {
  const criterion = item.completionFacts.criteria[0];
  if (!criterion) throw new Error("missing stable criterion");
  const result = WorkItem.CriterionResult.parse({
    id: `result:${item.hash}:${item.revision}`,
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
  const requestId = `completion-request:${item.hash}:${item.revision}`;
  const admission = WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${item.hash}:${item.revision + 1}:${decision}`,
    requestId,
    requestSnapshot: WorkItem.CompletionRequest.parse({
      version: 1,
      id: requestId,
      origin: "worker",
      workItemHash: item.hash,
      contractRevision: item.completionContract.revision,
      basisRef: item.completionContract.basisRef,
      expectedHead: item.revision,
      claims: [],
      observations: [],
      results: [result],
      invalidations: [],
      verificationErrors: [],
      effects: [],
    }),
    origin: "worker",
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
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

function completionReport(): WorkItem.CompletionReport {
  return {
    summary: "A raw Session caller must not close this WorkItem.",
    claims: [{ statement: "criterion one", evidenceIds: ["evidence:unreachable"] }],
    caveats: [],
    followUps: [],
  };
}

async function directCompletionCode(hash: string): Promise<unknown> {
  try {
    const result = await WorkItemStore.complete(hash, completionReport());
    if (typeof result !== "object" || result === null) return undefined;
    return Reflect.get(result, "code");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (typeof error !== "object" || error === null) throw error;
    return Reflect.get(error, "code");
  }
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
      basisRef: `${first.hash}:attempt:1`,
    });
    expect(first.completionContract.basisRef).not.toBe(second.completionContract.basisRef);
    expect(first.completionFacts).toEqual({
      ...WorkItem.emptyCompletionFacts(),
      criteria: [
        {
          id: WorkItem.criterionId(first.hash, 0, "criterion one"),
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

    const recorded = authorizedCompareAndSet(adapter, item.hash, item.revision, candidate);

    expect(recorded).toBe(true);
    expect(adapter.workItem.get(item.hash)?.revision).toBe(item.revision + 1);
    expect(adapter.workItem.get(item.hash)?.completionFacts.revision).toBe(1);
    expect(adapter.workItem.get(item.hash)?.completionFacts.criteria).toHaveLength(1);
    expect(adapter.workItem.get(item.hash)?.completionFacts.results).toHaveLength(1);
    expect(adapter.workItem.get(item.hash)?.completionFacts.admissions[0]?.decision).toBe("admit");
  });

  test("rejects stale compare-and-set without appending any fact", async () => {
    const adapter = configure();
    const item = await createItem();
    const first = admissionCandidate(item);
    expect(authorizedCompareAndSet(adapter, item.hash, item.revision, first)).toBe(true);
    const stale = admissionCandidate(item, "block");

    const recorded = authorizedCompareAndSet(adapter, item.hash, item.revision, stale);

    expect(recorded).toBe(false);
    expect(adapter.workItem.get(item.hash)?.completionFacts.admissions).toHaveLength(1);
    expect(adapter.workItem.get(item.hash)?.completionFacts.admissions[0]?.id).toBe(
      first.completionFacts.admissions[0]?.id,
    );
  });

  test("uses the shared WorkItem row revision after an ordinary mutation", async () => {
    const adapter = configure();
    const item = await createItem();
    const mutated = await WorkItemStore.addEvidence(item.hash, {
      kind: "verification",
      description: "ordinary mutation",
      passed: true,
    });
    if (!mutated) throw new Error("missing mutated item");
    const candidate = admissionCandidate(mutated);

    const recorded = authorizedCompareAndSet(adapter, item.hash, mutated.revision, candidate);

    expect(mutated).toMatchObject({ revision: 1 });
    expect(mutated.completionFacts.revision).toBe(0);
    expect(recorded).toBe(true);
    expect(adapter.workItem.get(item.hash)).toMatchObject({ revision: 2 });
    expect(adapter.workItem.get(item.hash)?.completionFacts.admissions).toHaveLength(1);
  });

  test.each([
    "pending",
    "admitted",
    "blocked",
    "escalated",
  ] as const)("returns typed admission_required with zero mutation for raw completion of a %s item", async (state) => {
    const adapter = configure();
    const item = await createItem();
    if (state !== "pending") {
      const decision = state === "admitted" ? "admit" : state === "blocked" ? "block" : "escalate";
      const candidate = admissionCandidate(item, decision);
      expect(authorizedCompareAndSet(adapter, item.hash, item.revision, candidate)).toBe(true);
    }
    const before = adapter.workItem.get(item.hash);

    const code = await directCompletionCode(item.hash);

    expect(code).toBe("admission_required");
    expect(adapter.workItem.get(item.hash)).toEqual(before);
  });

  test("does not expose product admission mutation methods from WorkItemStore", () => {
    expect(Reflect.get(WorkItemStore, "appendCompletionAdmission")).toBeUndefined();
    expect(Reflect.get(WorkItemStore, "completeWithAdmission")).toBeUndefined();
  });
});
