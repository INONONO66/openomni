import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus, Storage, WorkerRun, WorkerRunStateStore } from "@openomni/session";
import { Subagent } from "@openomni/protocol";
import { recoverInterruptedRuns } from "../../src/recovery";

function seedSession(id: string): void {
  Storage.getAdapter().session.set(id, {
    id,
    title: "test",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now(), updated: Date.now() },
    spawnDepth: 0,
  });
}

async function seedRunAtStatus(
  sessionId: string,
  runId: string,
  targetStatus:
    | "queued"
    | "starting"
    | "running"
    | "waiting_input"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted",
): Promise<void> {
  await WorkerRun.create(sessionId, { runId, title: "task", prompt: "do it" });
  if (targetStatus === "queued") return;
  await WorkerRun.updateStatus(sessionId, runId, "starting");
  if (targetStatus === "starting") return;
  await WorkerRun.updateStatus(sessionId, runId, "running");
  if (targetStatus === "running") return;
  if (targetStatus === "waiting_input") {
    await WorkerRun.updateStatus(sessionId, runId, "waiting_input");
    return;
  }
  await WorkerRun.updateStatus(sessionId, runId, targetStatus, { endedAt: Date.now() });
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
});

afterEach(() => {
  Storage.reset();
});

describe("recoverInterruptedRuns", () => {
  test("marks running runs as interrupted", async () => {
    seedSession("s1");
    await seedRunAtStatus("s1", "r1", "running");

    const result = await recoverInterruptedRuns();

    const run = await WorkerRun.get("s1", "r1");
    expect(run?.status).toBe("interrupted");
    expect(run?.endedAt).toBeGreaterThan(0);
    expect(result.recovered).toBe(1);
    expect(result.sessions).toEqual(["s1"]);
  });

  test("marks starting runs as interrupted", async () => {
    seedSession("s2");
    await seedRunAtStatus("s2", "r2", "starting");

    const result = await recoverInterruptedRuns();

    const run = await WorkerRun.get("s2", "r2");
    expect(run?.status).toBe("interrupted");
    expect(result.recovered).toBe(1);
  });

  test("marks waiting_input runs as interrupted", async () => {
    seedSession("s-waiting");
    await seedRunAtStatus("s-waiting", "r-waiting", "waiting_input");

    const result = await recoverInterruptedRuns();

    const run = await WorkerRun.get("s-waiting", "r-waiting");
    expect(run?.status).toBe("interrupted");
    expect(result.recovered).toBe(1);
  });

  test("publishes WorkerRunFailed event for each interrupted run", async () => {
    seedSession("s3");
    await seedRunAtStatus("s3", "r3a", "running");
    await seedRunAtStatus("s3", "r3b", "running");

    const events: Array<{ sessionId: string; runId: string; error?: string }> = [];
    const unsub = Bus.subscribe(Subagent.Events.WorkerRunFailed, (data) => {
      events.push(data.payload);
    });

    await recoverInterruptedRuns();
    unsub();

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.sessionId === "s3")).toBe(true);
    expect(events.map((e) => e.runId).sort()).toEqual(["r3a", "r3b"].sort());
    expect(events.every((e) => e.error === "coordinator restarted: run interrupted")).toBe(true);
  });

  test("terminal runs are not affected", async () => {
    seedSession("s4");
    await seedRunAtStatus("s4", "r-succeeded", "succeeded");
    await seedRunAtStatus("s4", "r-failed", "failed");
    await seedRunAtStatus("s4", "r-cancelled", "cancelled");
    await seedRunAtStatus("s4", "r-interrupted", "interrupted");

    const result = await recoverInterruptedRuns();

    expect(result.recovered).toBe(0);
    expect(result.sessions).toHaveLength(0);

    const statuses = await Promise.all([
      WorkerRun.get("s4", "r-succeeded"),
      WorkerRun.get("s4", "r-failed"),
      WorkerRun.get("s4", "r-cancelled"),
      WorkerRun.get("s4", "r-interrupted"),
    ]);
    expect(statuses.map((r) => r?.status)).toEqual([
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ]);
  });

  test("queued runs are not affected", async () => {
    seedSession("s5");
    await seedRunAtStatus("s5", "r5", "queued");

    const result = await recoverInterruptedRuns();

    expect(result.recovered).toBe(0);
    const run = await WorkerRun.get("s5", "r5");
    expect(run?.status).toBe("queued");
  });

  test("skips runs changed by an active writer after the recovery scan", async () => {
    seedSession("s-active");
    await seedRunAtStatus("s-active", "r-active", "running");

    const workerRunState = Storage.get().workerRunState;
    if (!workerRunState) throw new Error("workerRunState adapter missing");

    const listBySession = workerRunState.listBySession.bind(workerRunState);
    let changedAfterScan = false;
    workerRunState.listBySession = (sessionId) => {
      const rows = listBySession(sessionId);
      if (sessionId === "s-active" && !changedAfterScan) {
        changedAfterScan = true;
        WorkerRunStateStore.updateStatus(sessionId, "r-active", "succeeded");
      }
      return rows;
    };

    const result = await recoverInterruptedRuns();

    const run = await WorkerRun.get("s-active", "r-active");
    expect(run?.status).toBe("succeeded");
    expect(result.recovered).toBe(0);
    expect(result.sessions).toEqual([]);
  });

  test("status precondition rejects runs touched without a status change", async () => {
    seedSession("s-touch");
    await seedRunAtStatus("s-touch", "r-touch", "running");

    const scanned = WorkerRunStateStore.get("s-touch", "r-touch");
    expect(scanned?.status).toBe("running");
    if (!scanned) throw new Error("r-touch not found before active write");
    WorkerRunStateStore.updateStatus("s-touch", "r-touch", "running");

    const interrupted = await WorkerRun.updateStatusIfCurrent(
      "s-touch",
      "r-touch",
      { status: scanned.status, timeUpdated: scanned.timeUpdated },
      "interrupted",
      { endedAt: Date.now(), error: "stale recovery update" },
    );

    const run = await WorkerRun.get("s-touch", "r-touch");
    expect(run?.status).toBe("running");
    expect(run?.timeUpdated).toBeGreaterThan(scanned.timeUpdated);
    expect(interrupted).toBe(false);
  });

  test("deduplicates sessions in result when multiple runs recovered from same session", async () => {
    seedSession("s6");
    await seedRunAtStatus("s6", "r6a", "running");
    await seedRunAtStatus("s6", "r6b", "running");

    const result = await recoverInterruptedRuns();

    expect(result.recovered).toBe(2);
    expect(result.sessions).toEqual(["s6"]);
  });

  test("recovery completes in under 10 seconds", async () => {
    for (let i = 0; i < 20; i++) {
      seedSession(`perf-s${i}`);
      await seedRunAtStatus(`perf-s${i}`, `perf-r${i}`, "running");
    }

    const start = Date.now();
    await recoverInterruptedRuns();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(10_000);
  });
});
