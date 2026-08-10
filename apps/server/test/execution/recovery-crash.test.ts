import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkItem } from "@openomni/protocol";
import { Storage, WorkItemAttemptRun, WorkItemStore } from "@openomni/session";
import { recoverInterruptedRuns } from "../../src/execution/recovery";

/**
 * #510 D2b — boot recovery over WorkItem attempt facts. The worker-run
 * store is frozen: recovery scans active attempts (allocated, unfinished)
 * and records `interrupted` terminal facts for in-process executors only.
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

type RunState = "allocated" | "waiting_input" | WorkItem.AttemptOutcome;

async function seedAttemptRun(
  sessionId: string,
  runId: string,
  state: RunState | "unallocated",
  executorKind: WorkItem.ExecutorKind = "internal_chat_agent",
): Promise<string> {
  const created = await WorkItemStore.create({
    name: `run ${runId}`,
    sourceMessageId: `seed:${runId}`,
    sourceChannel: "ingress",
    intent: "worker.dispatch",
    goal: "do it",
    sessionId,
    workSessionId: sessionId,
    workerRunId: runId,
    executorKind,
    acceptanceCriteria: ["the dispatched worker run reaches a terminal attempt outcome"],
  });
  await WorkItemStore.start(created.hash);
  if (state === "unallocated") return created.hash;
  const allocation = await WorkItemStore.allocateAttempt(created.hash, attemptIdentity("do it"));
  if (!allocation) throw new Error(`attempt allocation failed for ${runId}`);
  if (state === "allocated") return created.hash;
  if (state === "waiting_input") {
    if (!(await WorkItemAttemptRun.beginWait(sessionId, runId))) {
      throw new Error(`beginWait failed for ${runId}`);
    }
    return created.hash;
  }
  if (!(await WorkItemAttemptRun.finish(sessionId, runId, state, { endedAt: Date.now() }))) {
    throw new Error(`finish failed for ${runId}`);
  }
  return created.hash;
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

describe("recoverInterruptedRuns", () => {
  test("marks active runs as interrupted with the terminal attempt fact", async () => {
    await seedAttemptRun("s1", "r1", "allocated");

    const result = await recoverInterruptedRuns();

    const run = WorkItemAttemptRun.find("s1", "r1");
    expect(run?.status).toBe("interrupted");
    expect(run?.endedAt).toBeGreaterThan(0);
    expect(run?.error).toBe("coordinator restarted: run interrupted");
    expect(result.recovered).toBe(1);
    expect(result.sessions).toEqual(["s1"]);
  });

  test("marks waiting_input runs as interrupted and releases the wait blocker", async () => {
    const hash = await seedAttemptRun("s-waiting", "r-waiting", "waiting_input");

    const result = await recoverInterruptedRuns();

    const run = WorkItemAttemptRun.find("s-waiting", "r-waiting");
    expect(run?.status).toBe("interrupted");
    expect(result.recovered).toBe(1);
    const item = WorkItemStore.get(hash);
    expect(item?.blockers.every((blocker) => blocker.resolvedAt !== undefined)).toBe(true);
  });

  test("records the interrupted attempt fact on the work stream for each recovered run", async () => {
    await seedAttemptRun("s3", "r3a", "allocated");
    await seedAttemptRun("s3", "r3b", "allocated");

    await recoverInterruptedRuns();

    const ledger = Storage.get().ledger;
    if (!ledger) throw new Error("ledger sub-adapter missing");
    const finished = ledger
      .factsByType("work_item.attempt_finished")
      .map((fact) => fact.data as { outcome?: string; error?: string });
    expect(finished).toHaveLength(2);
    expect(
      finished.every(
        (fact) =>
          fact.outcome === "interrupted" && fact.error === "coordinator restarted: run interrupted",
      ),
    ).toBe(true);
  });

  test("terminal runs are not affected", async () => {
    await seedAttemptRun("s4", "r-succeeded", "succeeded");
    await seedAttemptRun("s4", "r-failed", "failed");
    await seedAttemptRun("s4", "r-cancelled", "cancelled");
    await seedAttemptRun("s4", "r-interrupted", "interrupted");

    const result = await recoverInterruptedRuns();

    expect(result.recovered).toBe(0);
    expect(result.sessions).toHaveLength(0);
    expect(
      ["r-succeeded", "r-failed", "r-cancelled", "r-interrupted"].map(
        (runId) => WorkItemAttemptRun.find("s4", runId)?.status,
      ),
    ).toEqual(["succeeded", "failed", "cancelled", "interrupted"]);
  });

  test("runs without an allocated attempt are not affected", async () => {
    const hash = await seedAttemptRun("s5", "r5", "unallocated");

    const result = await recoverInterruptedRuns();

    expect(result.recovered).toBe(0);
    expect(WorkItemStore.get(hash)?.attemptTerminal).toBeUndefined();
  });

  test("connector-endpoint attempts survive a kernel restart", async () => {
    await seedAttemptRun("s-connector", "r-connector", "allocated", "connector_endpoint");

    const result = await recoverInterruptedRuns();

    expect(result.recovered).toBe(0);
    expect(WorkItemAttemptRun.find("s-connector", "r-connector")?.status).toBe("running");
  });

  test("skips runs finished by an active writer after the recovery scan", async () => {
    await seedAttemptRun("s-active", "r-active", "allocated");

    const workItemAdapter = Storage.get().workItem;
    if (!workItemAdapter) throw new Error("workItem adapter missing");
    const list = workItemAdapter.list.bind(workItemAdapter);
    let finishedAfterScan = false;
    workItemAdapter.list = (filter) => {
      const rows = list(filter);
      if (!finishedAfterScan) {
        finishedAfterScan = true;
        // The concurrent writer wins the head CAS between scan and write.
        void WorkItemAttemptRun.finish("s-active", "r-active", "succeeded", {
          endedAt: Date.now(),
        });
      }
      return rows;
    };

    const result = await recoverInterruptedRuns();

    expect(WorkItemAttemptRun.find("s-active", "r-active")?.status).toBe("succeeded");
    expect(result.recovered).toBe(0);
    expect(result.sessions).toEqual([]);
  });

  test("deduplicates sessions in result when multiple runs recovered from same session", async () => {
    await seedAttemptRun("s6", "r6a", "allocated");
    await seedAttemptRun("s6", "r6b", "allocated");

    const result = await recoverInterruptedRuns();

    expect(result.recovered).toBe(2);
    expect(result.sessions).toEqual(["s6"]);
  });

  test("recovery completes in under 10 seconds", async () => {
    for (let i = 0; i < 20; i++) {
      await seedAttemptRun(`perf-s${i}`, `perf-r${i}`, "allocated");
    }

    const start = Date.now();
    await recoverInterruptedRuns();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10_000);
  });
});
