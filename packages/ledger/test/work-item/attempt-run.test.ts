import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";
import { WorkItemAttemptRun } from "../../src/work-item/attempt-run";
import { WorkItemStore } from "../../src/work-item/index";

/**
 * #510 D2b — the attempt-run surface over WorkItem attempt facts: the run
 * lifecycle that used to live in the worker-run second ledger (plus its
 * in-memory runExtras map).
 */

function attemptIdentity(prompt: string) {
  return {
    contentFingerprint: WorkItem.contentFingerprintOf({
      workInput: prompt,
      handlerKind: "internal_chat_agent",
      handlerCodeRef: { absent: true, reason: "not captured in tests" },
      model: {
        provider: "test",
        id: "test-model",
        parameters: { absent: true, reason: "no parameters configured" },
      },
      upstreamFingerprints: { absent: true, reason: "no upstream attempts" },
      dependencyLock: { absent: true, reason: "not read in tests" },
    }),
    environmentFingerprint: WorkItem.environmentFingerprintOf({
      os: process.platform,
      arch: process.arch,
      bunVersion: process.versions.bun ?? process.version,
      workspaceRoot: { absent: true, reason: "no workspace in tests" },
      schemaVersions: { policyKernel: 1 },
      policy: { absent: true, reason: "no policy plan in tests" },
      toolVersions: { absent: true, reason: "not enumerated in tests" },
      verifierVersions: { absent: true, reason: "not enumerated in tests" },
      providerParameters: { absent: true, reason: "no provider parameters" },
      configRef: { absent: true, reason: "no config identity in tests" },
    }),
  };
}

async function seedRun(sessionId: string, runId: string, allocate = true): Promise<string> {
  const created = await WorkItemStore.create(
    {
      name: `run ${runId}`,
      sourceMessageId: `seed:${runId}`,
      sourceChannel: "ingress",
      intent: "worker.dispatch",
      goal: "do the work",
      sessionId,
      originSessionId: "parent-session",
      workSessionId: sessionId,
      workerRunId: runId,
      executorKind: "internal_chat_agent",
      acceptanceCriteria: ["the dispatched worker run reaches a terminal attempt outcome"],
    },
    "trace-test",
  );
  await WorkItemStore.start(created.workItemId, "trace-test");
  if (allocate) {
    const allocation = await WorkItemStore.allocateAttempt(
      created.workItemId,
      attemptIdentity("do the work"),
      "trace-test",
    );
    if (!allocation) throw new Error("attempt allocation failed");
  }
  return created.workItemId;
}

function seedLegacyRow(
  sessionId: string,
  runId: string,
  status: "queued" | "starting" | "running" | "waiting_input" | "succeeded" | "failed",
): void {
  const sessionAdapter = Storage.get().session;
  if (!sessionAdapter.get(sessionId)) {
    sessionAdapter.set(sessionId, {
      id: sessionId,
      title: sessionId,
      model: { providerID: "test", modelID: "test" },
      time: { created: Date.now(), updated: Date.now() },
      spawnDepth: 0,
    });
  }
  const adapter = Storage.get().workerRunState;
  if (!adapter) throw new Error("workerRunState sub-adapter missing");
  adapter.create(sessionId, {
    runId,
    parentSessionId: "legacy-parent",
    agentName: "worker",
    status,
    executorKind: "internal_chat_agent",
    title: "legacy run",
    prompt: "legacy prompt",
    // Distinct on purpose: the upcast pins startedAt/endedAt to their SOURCE
    // columns, which equal defaults could not tell apart.
    timeCreated: 1_000,
    timeUpdated: 2_000,
  });
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

describe("WorkItemAttemptRun", () => {
  test("finish rethrows a BUSY storage layer instead of reporting not-active (#606)", async () => {
    await seedRun("sess-busy", "run-busy");
    const workItem = Storage.get().workItem;
    if (!workItem) throw new Error("workItem adapter missing");
    const original = workItem.compareAndSet.bind(workItem);
    // SQLITE_BUSY shape as pinned by sqlite-busy.test.ts; facts.ts maps it to
    // StorageUnavailableError. The old catch swallowed it into `false`, which
    // callers discard — a busy DB silently lost the terminal attempt fact.
    Object.defineProperty(workItem, "compareAndSet", {
      configurable: true,
      value: () => {
        const busy = new Error("database is locked") as Error & { code: string; errno: number };
        busy.code = "SQLITE_BUSY";
        busy.errno = 5;
        throw busy;
      },
    });
    try {
      await expect(
        WorkItemAttemptRun.finish("sess-busy", "run-busy", "succeeded", "trace-busy", {}),
      ).rejects.toThrow();
    } finally {
      Object.defineProperty(workItem, "compareAndSet", { configurable: true, value: original });
    }
  });

  test("find returns the attempt-fact view with parent session and executor", async () => {
    const hash = await seedRun("sess-view", "run-view");

    const view = WorkItemAttemptRun.find("sess-view", "run-view");
    expect(view).toMatchObject({
      runId: "run-view",
      sessionId: "sess-view",
      parentSessionId: "parent-session",
      workItemHash: hash,
      executorKind: "internal_chat_agent",
      status: "running",
      source: "attempt_facts",
    });
    expect(view?.attemptId).toBeDefined();
    expect(view?.startedAt).toBeGreaterThan(0);
  });

  test("finish records endedAt/error as the attempt terminal fact", async () => {
    const hash = await seedRun("sess-finish", "run-finish");

    const finished = await WorkItemAttemptRun.finish(
      "sess-finish",
      "run-finish",
      "succeeded",
      "trace-test",
      {
        endedAt: 1234,
      },
    );
    expect(finished).toBe(true);

    const view = WorkItemAttemptRun.find("sess-finish", "run-finish");
    expect(view?.status).toBe("succeeded");
    expect(view?.endedAt).toBe(1234);

    // The terminal record is the appended decision-class fact, durable on
    // the work stream (not an in-memory remainder).
    const facts = Storage.get().ledger?.factsByType("work_item.attempt_finished") ?? [];
    const fact = facts.find((candidate) => candidate.streamId === `work:${hash}`);
    expect(fact?.data).toMatchObject({
      outcome: "succeeded",
      endedAt: 1234,
    });

    // Idempotent-finish semantics: a second terminal write is a no-op
    // receipt, never a second fact.
    await expect(
      WorkItemAttemptRun.finish("sess-finish", "run-finish", "failed", "trace-test", {
        endedAt: 2000,
      }),
    ).resolves.toBe(false);
    expect(WorkItemAttemptRun.find("sess-finish", "run-finish")?.status).toBe("succeeded");
  });

  test("failed/interrupted outcomes fold the work item to failed with the reason", async () => {
    const hash = await seedRun("sess-fail", "run-fail");

    await WorkItemAttemptRun.finish("sess-fail", "run-fail", "interrupted", "trace-test", {
      endedAt: Date.now(),
      error: "coordinator restarted: run interrupted",
    });

    const item = WorkItemStore.get(hash);
    if (!item) throw new Error("work item missing");
    expect(WorkItem.deriveStatus(item)).toBe("failed");
    expect(item.failureReason).toBe("coordinator restarted: run interrupted");
    expect(item.attemptTerminal?.outcome).toBe("interrupted");
  });

  test("beginWait acquires exclusively; endWait releases; terminal runs reject the wait", async () => {
    await seedRun("sess-wait", "run-wait");

    expect(await WorkItemAttemptRun.beginWait("sess-wait", "run-wait", "trace-test")).toBe(true);
    expect(WorkItemAttemptRun.find("sess-wait", "run-wait")?.status).toBe("waiting_input");
    // Second acquire loses.
    expect(await WorkItemAttemptRun.beginWait("sess-wait", "run-wait", "trace-test")).toBe(false);

    expect(await WorkItemAttemptRun.endWait("sess-wait", "run-wait", "trace-test")).toBe(true);
    expect(WorkItemAttemptRun.find("sess-wait", "run-wait")?.status).toBe("running");
    // Releasing an unheld wait is a no-op receipt.
    expect(await WorkItemAttemptRun.endWait("sess-wait", "run-wait", "trace-test")).toBe(false);

    await WorkItemAttemptRun.finish("sess-wait", "run-wait", "cancelled", "trace-test", {
      endedAt: Date.now(),
    });
    expect(await WorkItemAttemptRun.beginWait("sess-wait", "run-wait", "trace-test")).toBe(false);
  });

  test("a new allocation clears the previous attempt terminal", async () => {
    const hash = await seedRun("sess-realloc", "run-realloc");
    await WorkItemAttemptRun.finish("sess-realloc", "run-realloc", "succeeded", "trace-test", {
      endedAt: 1,
    });

    const allocation = await WorkItemStore.allocateAttempt(
      hash,
      attemptIdentity("again"),
      "trace-test",
    );
    expect(allocation).toBeDefined();
    const view = WorkItemAttemptRun.find("sess-realloc", "run-realloc");
    expect(view?.status).toBe("running");
    expect(view?.endedAt).toBeUndefined();
    expect(view?.attemptId).toBe(allocation?.attempt.attemptId);
  });

  test("listActive returns unfinished attempts only and never legacy rows", async () => {
    await seedRun("sess-active", "run-a");
    await seedRun("sess-active", "run-b");
    await seedRun("sess-active", "run-unallocated", false);
    await WorkItemAttemptRun.finish("sess-active", "run-b", "succeeded", "trace-test", {
      endedAt: 1,
    });
    seedLegacyRow("sess-active", "run-legacy-live", "running");

    const active = WorkItemAttemptRun.listActive("sess-active");
    expect(active.map((run) => run.runId)).toEqual(["run-a"]);
  });

  test("legacy rows upcast deterministically: terminal 1:1, non-terminal folds to interrupted", async () => {
    seedLegacyRow("sess-upcast", "run-legacy-done", "succeeded");
    seedLegacyRow("sess-upcast", "run-legacy-open", "waiting_input");

    const done = WorkItemAttemptRun.find("sess-upcast", "run-legacy-done");
    expect(done).toMatchObject({
      status: "succeeded",
      parentSessionId: "legacy-parent",
      source: "worker_run_upcast",
    });
    // Terminal legacy rows derive endedAt from their persisted update time —
    // the only timestamp the frozen archive still carries for the end. The
    // seeded values are distinct so a swapped source column cannot pass.
    expect(done?.startedAt).toBe(1_000);
    expect(done?.endedAt).toBe(2_000);

    const open = WorkItemAttemptRun.find("sess-upcast", "run-legacy-open");
    expect(open?.status).toBe("interrupted");
    expect(open?.error).toContain("worker_run frozen");
    // Deterministic: the same archived row always produces the same view,
    // and the read wrote nothing.
    expect(WorkItemAttemptRun.find("sess-upcast", "run-legacy-open")).toEqual(open);
    expect(await WorkItemAttemptRun.beginWait("sess-upcast", "run-legacy-open", "trace-test")).toBe(
      false,
    );
  });
});
