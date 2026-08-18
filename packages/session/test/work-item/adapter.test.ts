import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkItem } from "@openomni/protocol";
import { Storage } from "../../src/storage/index";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage";
import { completedFixtureResults } from "./completed-fixture.js";

function makeWorkItem(overrides: Partial<WorkItem.Info> = {}): WorkItem.Info {
  const item: WorkItem.Info = {
    workItemId: "wi_1",
    revision: 0,
    name: "Test item",
    sourceMessageId: "msg-1",
    sourceChannel: "discord",
    attempt: 1,
    lastAttemptSeq: 0,
    timestamps: { created: 1, updated: 1 },
    relations: { childIds: [], dependsOn: [] },
    intent: "test",
    goal: "verify persistence",
    blockers: [],
    evidence: [],
    constraints: [],
    acceptanceCriteria: ["the item remains parseable"],
    changedFiles: [],
    completionContract: {
      version: 1,
      revision: "contract:adapter:v1",
      basisRef: "basis:adapter:v1",
    },
    completionFacts: WorkItem.emptyCompletionFacts(),
    ...overrides,
  };
  item.completionFacts = overrides.completionFacts ?? {
    ...item.completionFacts,
    criteria: item.acceptanceCriteria.map((statement, index) => ({
      id: WorkItem.criterionId(item.workItemId, index, statement),
      revision: 1,
      statement,
      required: true,
    })),
  };
  if (item.timestamps.completed === undefined) return item;
  const criterion = item.completionFacts.criteria[0];
  if (!criterion) throw new Error("completed adapter fixture requires one criterion");
  const evidenceId = `evidence:${item.workItemId}:adapter-fixture`;
  const observation = WorkItem.Observation.parse({
    id: `observation:${item.workItemId}:adapter-fixture`,
    producer: "adapter-fixture",
    subjectRef: item.workItemId,
    basisRef: item.completionContract.basisRef,
    artifactRefs: [evidenceId],
    provenanceRef: evidenceId,
    ancestryRefs: [],
    observedAt: item.timestamps.completed,
  });
  const claim = WorkItem.Claim.parse({
    id: `claim:${item.workItemId}:adapter-fixture`,
    criterionId: criterion.id,
    statement: criterion.statement,
    observationIds: [observation.id],
    basisRef: item.completionContract.basisRef,
    createdAt: item.timestamps.completed,
  });
  const results = completedFixtureResults(item, "adapter-fixture").map((result, index) =>
    index === 0 ? { ...result, observationIds: [observation.id] } : result,
  );

  const completionReport = WorkItem.canonicalCompletionReport({
    summary: "Storage adapter fixture completed.",
    claims: [
      {
        statement:
          item.completionFacts.criteria[0]?.statement ?? "Storage adapter fixture completed.",
        evidenceIds: [evidenceId],
      },
    ],
    caveats: [],
    followUps: [],
  });
  const completionReportRef = WorkItem.completionReportReference(completionReport);
  const admission = WorkItem.CompletionAdmission.parse({
    version: 1,
    id: `admission:${item.workItemId}:adapter`,
    requestId: `completion-request:${item.workItemId}:adapter`,
    workItemHash: item.workItemId,
    origin: "recovery",
    contractRevision: item.completionContract.revision,
    basisRef: item.completionContract.basisRef,
    requestRoot: "request-root:adapter-fixture",
    proposedFactIds: {
      claims: [claim.id],
      observations: [observation.id],
      results: results.map(({ id }) => id),
      invalidations: [],
      verificationErrors: [],
      effects: [],
    },
    effectiveResultIds: results.map(({ id }) => id),
    unresolvedCriterionIds: [],
    decision: "admit",
    reasonCodes: ["adapter_fixture"],
    residualRisks: [],
    policyRef: "policy:adapter",
    completionReportSnapshot: completionReport,
    completionReportRef,
    expectedHead: item.revision,
    recordedHead: item.revision + 1,
    createdAt: item.timestamps.completed,
  });
  return {
    ...item,
    revision: admission.recordedHead + 1,
    evidence: [
      ...item.evidence,
      {
        id: evidenceId,
        kind: "verification",
        description: "Storage adapter fixture evidence",
        passed: true,
        attempt: item.attempt,
        basisRef: item.completionContract.basisRef,
        createdAt: item.timestamps.completed,
      },
    ],
    completionFacts: {
      ...item.completionFacts,
      revision: item.completionFacts.revision + 1,
      claims: [...item.completionFacts.claims, claim],
      observations: [...item.completionFacts.observations, observation],
      results: [...item.completionFacts.results, ...results],
      admissions: [admission],
    },
    completionReport,
    completionTerminalReceipt: {
      version: 1,
      hash: item.workItemId,
      requestId: admission.requestId,
      admissionId: admission.id,
      contractRevision: admission.contractRevision,
      basisRef: admission.basisRef,
      completionReportRef,
      recordedHead: admission.recordedHead + 1,
    },
  };
}

function persistCompletedFixture(adapter: SqliteStorageAdapter, item: WorkItem.Info): void {
  const { completed: _completed, ...nonterminalTimestamps } = item.timestamps;
  const admission = item.completionFacts.admissions[0];
  if (!admission) throw new Error("missing completed fixture admission");
  const baseline = WorkItem.Info.parse({
    ...item,
    revision: 0,
    completionReport: undefined,
    completionTerminalReceipt: undefined,
    completionFacts: {
      ...WorkItem.emptyCompletionFacts(),
      criteria: item.completionFacts.criteria,
    },
    timestamps: nonterminalTimestamps,
  });
  const admitted = WorkItem.Info.parse({
    ...item,
    revision: admission.recordedHead,
    completionReport: undefined,
    completionTerminalReceipt: undefined,
    completionFacts: {
      ...item.completionFacts,
      revision: 1,
      admissions: [admission],
    },
    timestamps: nonterminalTimestamps,
  });
  const completionWriter = Storage.configure(adapter);
  expect(adapter.workItem?.create(item.workItemId, baseline)).toBe(true);
  expect(completionWriter(item.workItemId, baseline.revision, admitted)).toBe(true);
  expect(completionWriter(item.workItemId, admitted.revision, item)).toBe(true);
}

describe("SqliteStorageAdapter workItem", () => {
  let fixtureDir = "";
  let dbPath = "";
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "openomni-work-item-"));
    dbPath = join(fixtureDir, "work-item.db");
    adapter = new SqliteStorageAdapter(dbPath);
  });

  afterEach(() => {
    try {
      adapter.close();
    } catch (_err) {
      void _err;
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("round-trips through get, list, and remove", () => {
    const item = makeWorkItem({
      workItemId: "wi_000roundtrip",
      sessionId: "session-1",
      assigneeId: "agent-1",
      relations: { parentId: "parent-1", childIds: [], dependsOn: [] },
      timestamps: { created: 1000, updated: 1000 },
    });

    expect(adapter.workItem?.create(item.workItemId, item)).toBe(true);

    const parsed = WorkItem.Info.parse(item);
    expect(adapter.workItem?.get(item.workItemId)).toEqual(parsed);
    expect(adapter.workItem?.list()).toEqual([parsed]);
    expect(adapter.workItem?.remove(item.workItemId)).toBe(true);
    expect(adapter.workItem?.get(item.workItemId)).toBeUndefined();
  });

  test("#498 K2: a persisted pre-rename row (hash/parentHash/childHashes data blob) reads back upcast", () => {
    // Simulate a work_item row EXACTLY as pre-rename writers persisted it:
    // the data blob carries the retired keys; the sqlite columns are
    // unchanged (`hash`, `parent_hash` — column names are persisted surface).
    const item = makeWorkItem({
      workItemId: "wi_000legacyrow",
      sessionId: "session-legacy",
      relations: { parentId: "wi_000oldparent", childIds: ["wi_0000oldchild"], dependsOn: [] },
      timestamps: { created: 500, updated: 500 },
    });
    const { workItemId, relations, ...rest } = WorkItem.Info.parse(item);
    const legacyBlob = {
      ...rest,
      hash: workItemId,
      relations: {
        parentHash: relations.parentId,
        childHashes: relations.childIds,
        dependsOn: relations.dependsOn,
      },
    };
    const db = new Database(dbPath);
    db.query(
      `INSERT INTO work_item
         (hash, data, revision, status, assignee_id, session_id, parent_hash, source_channel, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      workItemId,
      JSON.stringify(legacyBlob),
      legacyBlob.revision,
      "pending",
      null,
      "session-legacy",
      relations.parentId ?? null,
      legacyBlob.sourceChannel,
      500,
      500,
    );
    db.close();

    const read = adapter.workItem?.get(workItemId);
    expect(read?.workItemId).toBe(workItemId);
    expect(read?.relations.parentId).toBe("wi_000oldparent");
    expect(read?.relations.childIds).toEqual(["wi_0000oldchild"]);
    // criterionId revalidation passed inside Info.parse (the id value is
    // unchanged), and the retired keys do not survive the read.
    expect(read && "hash" in read).toBe(false);
    expect(read && "parentHash" in read.relations).toBe(false);
    // The parent_hash COLUMN keeps serving the list filter under its old name.
    expect(adapter.workItem?.list({ parentId: "wi_000oldparent" })).toHaveLength(1);
  });

  test("rejects direct creation of completed WorkItems", () => {
    const item = makeWorkItem({
      workItemId: "wi_000rawterminal",
      timestamps: { created: 1000, updated: 1000, completed: 2000 },
    });

    expect(() => adapter.workItem?.create(item.workItemId, item)).toThrow(
      "WorkItem create accepts pending completion baselines only",
    );
    expect(adapter.workItem?.get(item.workItemId)).toBeUndefined();
  });

  test("rejects a raw completion baseline whose facts revision is not zero", () => {
    const item = makeWorkItem({
      workItemId: "wi_000rawfactsrevision",
      completionFacts: {
        ...WorkItem.emptyCompletionFacts(),
        revision: 1,
        criteria: [
          {
            id: WorkItem.criterionId("wi_000rawfactsrevision", 0, "the item remains parseable"),
            revision: 1,
            statement: "the item remains parseable",
            required: true,
          },
        ],
      },
    });

    expect(() => adapter.workItem?.create(item.workItemId, item)).toThrow(
      "WorkItem create accepts pending completion baselines only",
    );
    expect(adapter.workItem?.get(item.workItemId)).toBeUndefined();
  });

  test("rejects mismatched row and payload hashes across read paths", () => {
    const rowKey = "wi_mismatch_row_key";
    const payload = makeWorkItem({ workItemId: "wi_mismatch_payload" });
    adapter.close();
    const database = new Database(dbPath);
    database
      .query(
        `INSERT INTO work_item
           (hash, data, status, source_channel, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rowKey,
        JSON.stringify(payload),
        "pending",
        payload.sourceChannel,
        payload.timestamps.created,
        payload.timestamps.updated,
      );
    database.close();
    adapter = new SqliteStorageAdapter(dbPath);

    expect(() => adapter.workItem.get(rowKey)).toThrow(
      `WorkItem hash mismatch: key=${rowKey} payload=${payload.workItemId}`,
    );
    expect(() => adapter.workItem.list()).toThrow(
      `WorkItem hash mismatch: key=${rowKey} payload=${payload.workItemId}`,
    );
    const incomingHash = "wi_incoming_payload_hash";
    expect(() =>
      adapter.workItem.compareAndSet(rowKey, -1, makeWorkItem({ workItemId: incomingHash })),
    ).toThrow(`WorkItem hash mismatch: key=${rowKey} payload=${incomingHash}`);
    expect(() =>
      adapter.workItem.compareAndSet(rowKey, -1, makeWorkItem({ workItemId: rowKey })),
    ).toThrow(`WorkItem hash mismatch: key=${rowKey} payload=${payload.workItemId}`);
  });

  test("exposes no unconditional WorkItem upsert", () => {
    expect(adapter.workItem).not.toHaveProperty("set");
  });

  test("creates a WorkItem once without changing the duplicate row", () => {
    const original = makeWorkItem({ workItemId: "wi_insert_only", name: "original" });
    const duplicate = { ...original, revision: 1, name: "duplicate" };

    expect(adapter.workItem?.create(original.workItemId, original)).toBe(true);
    expect(adapter.workItem?.create(duplicate.workItemId, duplicate)).toBe(false);
    expect(adapter.workItem?.get(original.workItemId)).toEqual(original);
  });

  test("compareAndSet rejects a stale writer without changing any field", () => {
    const item = makeWorkItem({ workItemId: "wi_shared_head" });
    const firstWriter = {
      ...item,
      revision: 1,
      name: "first writer",
      timestamps: { ...item.timestamps, updated: 2 },
    };
    const staleWriter = {
      ...item,
      revision: 1,
      name: "stale writer",
      goal: "stale goal",
      timestamps: { ...item.timestamps, updated: 3 },
    };
    expect(adapter.workItem?.create(item.workItemId, item)).toBe(true);

    expect(adapter.workItem?.compareAndSet(item.workItemId, 0, firstWriter)).toBe(true);
    expect(adapter.workItem?.compareAndSet(item.workItemId, 0, staleWriter)).toBe(false);
    expect(adapter.workItem?.get(item.workItemId)).toEqual(firstWriter);
  });

  test("authorized completion writes cannot rewrite admitted observations", () => {
    const completed = makeWorkItem({
      workItemId: "wi_append_only_completion",
      timestamps: { created: 1, updated: 3, completed: 3 },
    });
    persistCompletedFixture(adapter, completed);
    const current = adapter.workItem?.get(completed.workItemId);
    const observation = current?.completionFacts.observations[0];
    const admission = current?.completionFacts.admissions[0];
    if (!current || !observation || !admission) throw new Error("missing completed fixture facts");
    const rewrittenObservation = WorkItem.Observation.parse({
      ...observation,
      producer: "claimant:rewritten",
      observedAt: observation.observedAt + 1,
    });
    const rewritten = {
      ...current,
      revision: current.revision + 1,
      timestamps: { ...current.timestamps, updated: current.timestamps.updated + 1 },
      completionFacts: {
        ...current.completionFacts,
        revision: current.completionFacts.revision + 1,
        observations: current.completionFacts.observations.map((candidate) =>
          candidate.id === observation.id ? rewrittenObservation : candidate,
        ),
      },
    };
    const completionWriter = Storage.configure(adapter);

    expect(() => completionWriter(current.workItemId, current.revision, rewritten)).toThrow(
      "completion observations are append-only",
    );
    expect(adapter.workItem?.get(current.workItemId)).toEqual(current);
  });

  test("authorized completion writes cannot remove request reservations", () => {
    const item = makeWorkItem({ workItemId: "wi_append_only_reservation" });
    const reservation = WorkItem.CompletionRequestReservation.parse({
      version: 1,
      id: "completion-reservation:append-only:1",
      requestId: "completion-request:append-only",
      requestRoot: "sha256:append-only",
      attempt: item.attempt,
      basisRef: item.completionContract.basisRef,
      envelopeDigest: "sha256:append-only-envelope",
      expectedHead: 0,
      recordedHead: 1,
      createdAt: 2,
      ownerId: "process:append-only",
      fence: 1,
      leaseExpiresAt: 100,
    });
    const reserved = WorkItem.Info.parse({
      ...item,
      revision: 1,
      completionFacts: {
        ...item.completionFacts,
        revision: 1,
        requestReservations: [reservation],
      },
      timestamps: { ...item.timestamps, updated: 2 },
    });
    const removed = WorkItem.Info.parse({
      ...reserved,
      revision: 2,
      completionFacts: {
        ...reserved.completionFacts,
        revision: 2,
        requestReservations: [],
      },
      timestamps: { ...reserved.timestamps, updated: 3 },
    });
    const completionWriter = Storage.configure(adapter);
    expect(adapter.workItem?.create(item.workItemId, item)).toBe(true);
    expect(completionWriter(item.workItemId, item.revision, reserved)).toBe(true);

    expect(() => completionWriter(item.workItemId, reserved.revision, removed)).toThrow(
      "completion request reservations are append-only",
    );
    expect(adapter.workItem?.get(item.workItemId)).toEqual(reserved);
  });

  test("authorized completion writes cannot rewrite reservation fences in place", () => {
    const item = makeWorkItem({ workItemId: "wi_append_only_fence" });
    const reservation = WorkItem.CompletionRequestReservation.parse({
      version: 1,
      id: "completion-reservation:fence-rewrite:1",
      requestId: "completion-request:fence-rewrite",
      requestRoot: "sha256:fence-rewrite",
      attempt: item.attempt,
      basisRef: item.completionContract.basisRef,
      envelopeDigest: "sha256:fence-rewrite-envelope",
      expectedHead: 0,
      recordedHead: 1,
      createdAt: 2,
      ownerId: "process:fence-rewrite",
      fence: 1,
      leaseExpiresAt: 100,
    });
    const reserved = WorkItem.Info.parse({
      ...item,
      revision: 1,
      completionFacts: {
        ...item.completionFacts,
        revision: 1,
        requestReservations: [reservation],
      },
      timestamps: { ...item.timestamps, updated: 2 },
    });
    const rewritten = WorkItem.Info.parse({
      ...reserved,
      revision: 2,
      completionFacts: {
        ...reserved.completionFacts,
        revision: 2,
        requestReservations: [{ ...reservation, fence: reservation.fence + 1 }],
      },
      timestamps: { ...reserved.timestamps, updated: 3 },
    });
    const completionWriter = Storage.configure(adapter);
    expect(adapter.workItem?.create(item.workItemId, item)).toBe(true);
    expect(completionWriter(item.workItemId, item.revision, reserved)).toBe(true);

    expect(() => completionWriter(item.workItemId, reserved.revision, rewritten)).toThrow(
      "completion request reservations are append-only",
    );
    expect(adapter.workItem?.get(item.workItemId)).toEqual(reserved);
  });

  test("list filters by status and sessionId", () => {
    const pending = makeWorkItem({
      workItemId: "wi_00000pending",
      sessionId: "s1",
      timestamps: { created: 1, updated: 1 },
    });
    const completed = makeWorkItem({
      workItemId: "wi_000completed",
      sessionId: "s2",
      timestamps: { created: 2, updated: 2, completed: 3 },
    });

    expect(adapter.workItem?.create(pending.workItemId, pending)).toBe(true);
    persistCompletedFixture(adapter, completed);

    expect(
      adapter.workItem?.list({ status: ["completed"] }).map((item) => item.workItemId),
    ).toEqual(["wi_000completed"]);
    expect(adapter.workItem?.list({ sessionId: "s1" }).map((item) => item.workItemId)).toEqual([
      "wi_00000pending",
    ]);
  });

  test("clear removes work items", () => {
    const items = [
      makeWorkItem({ workItemId: "wi_00000000000a", timestamps: { created: 1, updated: 1 } }),
      makeWorkItem({
        workItemId: "wi_00000000000b",
        timestamps: { created: 2, updated: 2 },
      }),
      makeWorkItem({
        workItemId: "wi_00000000000c",
        timestamps: { created: 3, updated: 3 },
      }),
    ];

    for (const item of items) {
      expect(adapter.workItem?.create(item.workItemId, item)).toBe(true);
    }

    adapter.clear();

    expect(adapter.workItem?.list()).toEqual([]);
  });
});
