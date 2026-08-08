import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkItem } from "@openomni/protocol";
import { initialize } from "../storage/initialize.js";
import { SqliteStorageAdapter } from "../storage/sqlite-storage.js";
import { Storage } from "../storage/storage.js";
import { attemptAllocatedFact } from "./facts.js";
import { WorkItemStore } from "./index.js";

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
  const adapter = Storage.getAdapter();
  if (adapter instanceof SqliteStorageAdapter) adapter.close();
  Storage.reset();
  rmSync(tempDir, { recursive: true, force: true });
});

async function createItem(name: string) {
  return WorkItemStore.create({
    name,
    sourceMessageId: `msg_${name}`,
    sourceChannel: "test",
    intent: "implement",
    goal: "verify attempt allocation",
    sessionId: "session_attempt",
    acceptanceCriteria: ["the attempt identity is recorded before anything acts"],
  });
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

    const allocation = await WorkItemStore.allocateAttempt(item.hash, identity());
    if (!allocation) throw new Error("expected an allocation");

    expect(allocation.attempt.attemptSeq).toBe(1);
    expect(allocation.attempt.retryOf).toBeNull();
    expect(allocation.attempt.reusedFromAttemptId).toBeNull();
    // Projection watermark mirrors the allocated identity.
    expect(allocation.item.lastAttemptSeq).toBe(1);
    expect(allocation.item.currentAttemptId).toBe(allocation.attempt.attemptId);

    const fact = workFactsOf(item.hash).at(-1);
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

    const first = await WorkItemStore.allocateAttempt(item.hash, identity());
    if (!first) throw new Error("expected the first allocation");

    // A failed run retried through the existing retry path keeps the
    // attempt-identity watermark: the next allocation advances the seq and
    // points its lineage at the recorded prior attempt.
    await WorkItemStore.fail(item.hash, "first attempt failed");
    await WorkItemStore.retry(item.hash);
    const second = await WorkItemStore.allocateAttempt(item.hash, identity("retry the goal"));
    if (!second) throw new Error("expected the second allocation");

    expect(first.attempt.attemptSeq).toBe(1);
    expect(second.attempt.attemptSeq).toBe(2);
    expect(second.attempt.attemptId).not.toBe(first.attempt.attemptId);
    expect(second.attempt.retryOf).toBe(first.attempt.attemptId);
    // Fingerprints may repeat or differ — identity does not.
    expect(second.item.lastAttemptSeq).toBe(2);
    expect(second.item.currentAttemptId).toBe(second.attempt.attemptId);
  });

  test("a non-monotonic seq is an explosive backstop, not a silent skip", async () => {
    const item = await createItem("attempt-backstop");
    const allocation = await WorkItemStore.allocateAttempt(item.hash, identity());
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
    await WorkItemStore.cancel(item.hash);

    await expect(WorkItemStore.allocateAttempt(item.hash, identity())).rejects.toThrow(
      "Cannot allocate an attempt on a cancelled work item",
    );
  });
});
