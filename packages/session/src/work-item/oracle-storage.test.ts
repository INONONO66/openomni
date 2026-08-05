import { afterEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Bus } from "../bus/index.js";
import { SqliteStorageAdapter } from "../storage/sqlite-storage.js";
import { Storage } from "../storage/storage.js";
import { WorkItemStore } from "./index.js";

const baseInput = {
  sourceMessageId: "msg_oracle_storage",
  sourceChannel: "test",
  intent: "verify storage concurrency",
  goal: "preserve one shared WorkItem row head",
  sessionId: "session_oracle_storage",
  acceptanceCriteria: ["storage mutations preserve the winning row"],
};

let adapter: SqliteStorageAdapter | undefined;
let completionWriter: Storage.WorkItemCompletionWriter;

function configureSqlite(): SqliteStorageAdapter {
  adapter = new SqliteStorageAdapter(":memory:");
  completionWriter = Storage.configure(adapter);
  return adapter;
}

async function createItem(
  name: string,
  extra?: Partial<Parameters<typeof WorkItemStore.create>[0]>,
): Promise<WorkItem.Info> {
  return WorkItemStore.create({ ...baseInput, ...extra, name });
}

function persistCompletedFixture(item: WorkItem.Info): WorkItem.Info {
  const admission = WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${item.hash}:oracle-storage`,
    requestId: `completion-request:${item.hash}:oracle-storage`,
    requestSnapshot: WorkItem.CompletionRequest.parse({
      version: 1,
      id: `completion-request:${item.hash}:oracle-storage`,
      origin: "recovery",
      workItemHash: item.hash,
      contractRevision: item.completionContract.revision,
      basisRef: item.completionContract.basisRef,
      expectedHead: item.revision,
      claims: [],
      observations: [],
      results: [],
      invalidations: [],
      verificationErrors: [],
      effects: [],
    }),
    origin: "recovery",
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    effectiveResultIds: [],
    unresolvedCriterionIds: [],
    decision: "admit",
    reasonCodes: ["oracle_storage_fixture"],
    residualRisks: [],
    policyRef: "policy:oracle-storage",
    expectedHead: item.revision,
    recordedHead: item.revision + 1,
    createdAt: item.timestamps.updated + 1,
  });
  const completed = WorkItem.Info.parse({
    ...item,
    revision: admission.recordedHead + 1,
    timestamps: {
      ...item.timestamps,
      updated: admission.createdAt + 1,
      completed: admission.createdAt + 1,
    },
    completionFacts: {
      ...item.completionFacts,
      revision: item.completionFacts.revision + 1,
      admissions: [admission],
    },
    completionTerminalReceipt: {
      version: 1,
      hash: item.hash,
      requestId: admission.requestId,
      admissionId: admission.id,
      contractRevision: admission.contractRevision,
      basisRef: admission.basisRef,
      recordedHead: admission.recordedHead + 1,
    },
  });
  const admitted = WorkItem.Info.parse({
    ...item,
    revision: admission.recordedHead,
    timestamps: { ...item.timestamps, updated: admission.createdAt },
    completionFacts: {
      ...item.completionFacts,
      revision: item.completionFacts.revision + 1,
      admissions: [admission],
    },
  });
  if (!completionWriter(item.hash, item.revision, admitted)) {
    throw new Error("failed to persist completed fixture admission");
  }
  if (!completionWriter(item.hash, admitted.revision, completed)) {
    throw new Error("failed to persist completed fixture terminal record");
  }
  return completed;
}

async function expectRejectsWithMessage(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) return;
    expect(error.message).toContain(message);
    return;
  }
  throw new Error(`Expected operation to reject with ${message}`);
}

afterEach(() => {
  Bus.reset();
  Storage.reset();
  adapter?.close();
  adapter = undefined;
});

describe("WorkItem oracle storage concurrency", () => {
  test("records Owner outcome through one shared row CAS", async () => {
    const storage = configureSqlite();
    const item = await createItem("CAS outcome");
    const completed = persistCompletedFixture(item);
    const originalCompareAndSet = storage.workItem.compareAndSet.bind(storage.workItem);
    const attemptedHeads: Array<readonly [number, number]> = [];
    storage.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (hash === item.hash) attemptedHeads.push([expectedHead, candidate.revision]);
      return originalCompareAndSet(hash, expectedHead, candidate);
    };

    const recorded = await WorkItemStore.recordOutcome(item.hash, "adopted");

    expect(attemptedHeads).toEqual([[completed.revision, completed.revision + 1]]);
    expect(recorded).toMatchObject({ revision: completed.revision + 1, outcome: "adopted" });
    expect(recorded?.completionTerminalReceipt).toEqual(completed.completionTerminalReceipt);
  });

  test("rejects a stale Owner outcome without rewinding the competing row", async () => {
    const storage = configureSqlite();
    const item = await createItem("Stale outcome");
    const completed = persistCompletedFixture(item);
    const originalCompareAndSet = storage.workItem.compareAndSet.bind(storage.workItem);
    let injectedCompetingWrite = false;
    storage.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (hash === item.hash && !injectedCompetingWrite) {
        injectedCompetingWrite = true;
        expect(
          originalCompareAndSet(hash, expectedHead, {
            ...completed,
            revision: expectedHead + 1,
            name: "competing winner",
            timestamps: { ...completed.timestamps, updated: completed.timestamps.updated + 1 },
          }),
        ).toBe(true);
      }
      return originalCompareAndSet(hash, expectedHead, candidate);
    };

    await expectRejectsWithMessage(
      WorkItemStore.recordOutcome(item.hash, "corrected"),
      `stale WorkItem revision: ${item.hash}`,
    );

    expect(injectedCompetingWrite).toBe(true);
    expect(WorkItemStore.get(item.hash)).toMatchObject({
      revision: completed.revision + 1,
      name: "competing winner",
    });
    expect(WorkItemStore.get(item.hash)?.outcome).toBeUndefined();
  });

  test("removes the inserted child when parent relation CAS loses", async () => {
    const storage = configureSqlite();
    const parent = await createItem("Raced parent");
    const originalCompareAndSet = storage.workItem.compareAndSet.bind(storage.workItem);
    let injectedCompetingWrite = false;
    storage.workItem.compareAndSet = (hash, expectedHead, candidate) => {
      if (hash === parent.hash && !injectedCompetingWrite) {
        injectedCompetingWrite = true;
        expect(
          originalCompareAndSet(hash, expectedHead, {
            ...parent,
            revision: expectedHead + 1,
            name: "parent race winner",
            timestamps: { ...parent.timestamps, updated: parent.timestamps.updated + 1 },
          }),
        ).toBe(true);
      }
      return originalCompareAndSet(hash, expectedHead, candidate);
    };

    await expectRejectsWithMessage(
      createItem("Orphan candidate", { parentHash: parent.hash }),
      `stale WorkItem revision: ${parent.hash}`,
    );

    expect(injectedCompetingWrite).toBe(true);
    expect(WorkItemStore.list({ parentHash: parent.hash })).toEqual([]);
    expect(WorkItemStore.list()).toHaveLength(1);
    expect(WorkItemStore.get(parent.hash)).toMatchObject({
      revision: parent.revision + 1,
      name: "parent race winner",
      relations: { childHashes: [] },
    });
  });
});
