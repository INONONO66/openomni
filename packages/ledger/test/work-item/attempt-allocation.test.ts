import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkItem } from "@openomni/protocol";
import { initialize } from "../../src/storage/initialize.js";
import { SqliteStorageAdapter } from "../../src/storage/sqlite-storage.js";
import { Storage } from "../../src/storage/storage.js";
import { attemptAllocatedFact } from "../../src/work-item/facts.js";
import { WorkItemStore } from "../../src/work-item/index.js";

let tempDir: string;
// Second connection on the same WAL file: fact assertions must not ride the
// writer's connection.
let inspect: Database;

beforeEach(() => {
  Storage.reset();
  tempDir = mkdtempSync(join(tmpdir(), "attempt-allocation-"));
  initialize({ dbPath: join(tempDir, "openomni.db") });
  inspect = new Database(join(tempDir, "openomni.db"));
});

afterEach(() => {
  inspect.close();
  const adapter = Storage.get();
  if (adapter instanceof SqliteStorageAdapter) adapter.close();
  Storage.reset();
  rmSync(tempDir, { recursive: true, force: true });
});

async function createItem(name: string) {
  return WorkItemStore.create(
    {
      name,
      sourceMessageId: `msg_${name}`,
      sourceChannel: "test",
      intent: "implement",
      goal: "verify attempt allocation",
      sessionId: "session_attempt",
      acceptanceCriteria: ["the attempt identity is recorded before anything acts"],
    },
    "trace-test",
  );
}

function identity(workInput = "verify attempt allocation") {
  return {
    contentFingerprint: WorkItem.contentFingerprintOf({
      workInput,
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true, reason: "not captured in this test" },
      model: {
        provider: "anthropic",
        id: "claude-test",
        parameters: { absent: true, reason: "no model parameters configured" },
      },
      upstreamFingerprints: {
        absent: true,
        reason: "no upstream attempts are consumed in this test",
      },
      dependencyLock: { absent: true, reason: "not read in this test" },
    }),
    environmentFingerprint: WorkItem.environmentFingerprintOf({
      os: process.platform,
      arch: process.arch,
      bunVersion: process.versions.bun ?? process.version,
      workspaceRoot: { absent: true, reason: "no workspace in this test" },
      schemaVersions: { policyKernel: 1 },
      policy: { absent: true, reason: "no policy plan in this test" },
      toolVersions: { absent: true, reason: "not enumerated in this test" },
      verifierVersions: { absent: true, reason: "not enumerated in this test" },
      providerParameters: { absent: true, reason: "no provider parameters configured" },
      configRef: { absent: true, reason: "no config identity in this test" },
    }),
  };
}

interface FactRow {
  readonly seq: number;
  readonly type: string;
  readonly data: string;
}

function workFactsOf(hash: string): FactRow[] {
  return inspect
    .query("SELECT seq, type, data FROM ledger_event WHERE stream_id = ? ORDER BY seq ASC")
    .all(`work:${hash}`) as FactRow[];
}

describe("WorkItemStore.allocateAttempt", () => {
  test("appends the full attempt identity as a fact at seq === projected revision", async () => {
    const item = await createItem("attempt-append");

    const allocation = await WorkItemStore.allocateAttempt(
      item.workItemId,
      identity(),
      "trace-test",
    );
    if (!allocation) throw new Error("expected an allocation");

    expect(allocation.attempt.attemptSeq).toBe(1);
    expect(allocation.attempt.retryOf).toBeNull();
    expect(allocation.attempt.reusedFromAttemptId).toBeNull();
    // Projection watermark mirrors the allocated identity.
    expect(allocation.item.lastAttemptSeq).toBe(1);
    expect(allocation.item.currentAttemptId).toBe(allocation.attempt.attemptId);

    const fact = workFactsOf(item.workItemId).at(-1);
    expect(fact?.type).toBe("work_item.attempt_allocated");
    expect(fact?.seq).toBe(allocation.item.revision);
    const payload = JSON.parse(fact?.data ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      attemptId: allocation.attempt.attemptId,
      attemptSeq: 1,
      retryOf: null,
      reusedFromAttemptId: null,
      revision: allocation.item.revision,
    });
    // The fact payload carries the FULL identity, fingerprints included.
    expect(WorkItem.ContentFingerprint.safeParse(payload.contentFingerprint).success).toBe(true);
    expect(WorkItem.EnvironmentFingerprint.safeParse(payload.environmentFingerprint).success).toBe(
      true,
    );
  });

  test("attemptSeq is monotonic and never reused; retryOf records the prior attempt lineage", async () => {
    const item = await createItem("attempt-monotonic");

    const first = await WorkItemStore.allocateAttempt(item.workItemId, identity(), "trace-test");
    if (!first) throw new Error("expected the first allocation");

    // A subsequent allocation advances the sequence and points its lineage
    // at the recorded prior attempt.
    const second = await WorkItemStore.allocateAttempt(
      item.workItemId,
      identity("retry the goal"),
      "trace-test",
    );
    if (!second) throw new Error("expected the second allocation");

    expect(first.attempt.attemptSeq).toBe(1);
    expect(second.attempt.attemptSeq).toBe(2);
    expect(second.attempt.attemptId).not.toBe(first.attempt.attemptId);
    expect(second.attempt.retryOf).toBe(first.attempt.attemptId);
    // Fingerprints may repeat or differ — identity does not.
    expect(second.item.lastAttemptSeq).toBe(2);
    expect(second.item.currentAttemptId).toBe(second.attempt.attemptId);
  });

  test("rejects evidence scoped to an earlier allocated attempt", async () => {
    const item = await createItem("stale-attempt-evidence");
    await WorkItemStore.assignExecution(
      item.workItemId,
      {
        executorKind: "internal_chat_agent",
        workerRunId: "run:stale-evidence",
        workSessionId: "session:stale-evidence",
      },
      "trace-test",
    );
    const first = await WorkItemStore.allocateAttempt(item.workItemId, identity(), "trace-test");
    if (!first) throw new Error("expected the first allocation");
    const firstScope = {
      expectedAttempt: first.attempt.attemptSeq,
      expectedBasisRef: first.item.completionContract.basisRef,
    };
    const second = await WorkItemStore.allocateAttempt(
      item.workItemId,
      identity("second attempt"),
      "trace-test",
    );
    if (!second) throw new Error("expected the second allocation");

    await expect(
      WorkItemStore.addEvidence(
        item.workItemId,
        { kind: "verification", description: "stale first-attempt evidence", passed: true },
        "trace-test",
        firstScope,
      ),
    ).rejects.toThrow("attempt changed before evidence recording");
    expect(second.item.evidence).toEqual([]);
  });

  test("checks attempt scope before explicit-id idempotent evidence replay", async () => {
    const item = await createItem("scoped-evidence-replay");
    const first = await WorkItemStore.allocateAttempt(item.workItemId, identity(), "trace-test");
    if (!first) throw new Error("expected the first allocation");
    const firstScope = {
      expectedAttempt: first.attempt.attemptSeq,
      expectedBasisRef: first.item.completionContract.basisRef,
    };
    const evidence = {
      id: "evidence:scoped-replay",
      kind: "verification" as const,
      description: "first-attempt evidence",
      passed: true,
    };

    const recorded = await WorkItemStore.addEvidence(
      item.workItemId,
      evidence,
      "trace-test",
      firstScope,
    );
    const replayed = await WorkItemStore.addEvidence(
      item.workItemId,
      evidence,
      "trace-test",
      firstScope,
    );
    expect(replayed).toEqual(recorded);
    expect(
      workFactsOf(item.workItemId).filter((fact) => fact.type === "work_item.evidence_appended"),
    ).toHaveLength(1);
    await expect(
      WorkItemStore.addEvidence(item.workItemId, evidence, "trace-test", {
        ...firstScope,
        expectedBasisRef: "stale-basis",
      }),
    ).rejects.toThrow("attempt changed before evidence recording");

    await WorkItemStore.allocateAttempt(item.workItemId, identity("second attempt"), "trace-test");
    await expect(
      WorkItemStore.addEvidence(item.workItemId, evidence, "trace-test", firstScope),
    ).rejects.toThrow("attempt changed before evidence recording");
  });

  test("cache reuse allocates a distinct immutable fact and rejects self-reuse", async () => {
    const item = await createItem("cache-reuse");
    const seeded = await WorkItemStore.allocateAttempt(item.workItemId, identity(), "trace-test");
    if (!seeded) throw new Error("expected seed allocation");
    const hit = await WorkItemStore.allocateAttempt(
      item.workItemId,
      { ...identity(), reusedFromAttemptId: seeded.attempt.attemptId },
      "trace-test",
    );
    if (!hit) throw new Error("expected cache-hit allocation");

    expect(hit.attempt.attemptId).not.toBe(seeded.attempt.attemptId);
    expect(hit.attempt.attemptSeq).toBe(seeded.attempt.attemptSeq + 1);
    expect(hit.attempt.reusedFromAttemptId).toBe(seeded.attempt.attemptId);
    expect(seeded.attempt.reusedFromAttemptId).toBeNull();
    const recorded = workFactsOf(item.workItemId)
      .filter((fact) => fact.type === "work_item.attempt_allocated")
      .map((fact) => JSON.parse(fact.data) as WorkItem.Attempt);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({
      attemptId: seeded.attempt.attemptId,
      reusedFromAttemptId: null,
    });
    expect(recorded[1]).toMatchObject({
      attemptId: hit.attempt.attemptId,
      reusedFromAttemptId: seeded.attempt.attemptId,
    });
    expect(
      WorkItem.Attempt.safeParse({ ...hit.attempt, reusedFromAttemptId: hit.attempt.attemptId })
        .success,
    ).toBe(false);
  });

  test("a non-monotonic seq is an explosive backstop, not a silent skip", async () => {
    const item = await createItem("attempt-backstop");
    const allocation = await WorkItemStore.allocateAttempt(
      item.workItemId,
      identity(),
      "trace-test",
    );
    if (!allocation) throw new Error("expected an allocation");

    expect(() =>
      attemptAllocatedFact(allocation.item, {
        ...allocation.attempt,
        attemptSeq: allocation.item.lastAttemptSeq + 2,
      }),
    ).toThrow("attemptSeq must advance once per serialized append");
  });

  test("terminal work items allocate nothing", async () => {
    const item = await createItem("attempt-terminal");
    await WorkItemStore.cancel(item.workItemId, "trace-test");

    await expect(
      WorkItemStore.allocateAttempt(item.workItemId, identity(), "trace-test"),
    ).rejects.toThrow("Cannot allocate an attempt on a cancelled work item");
  });
});
