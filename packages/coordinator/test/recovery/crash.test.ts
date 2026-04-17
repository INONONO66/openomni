import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bus, Storage, WorkerRun } from "@openomni/session";
import { Subagent } from "@openomni/protocol";
import { recoverInterruptedRuns } from "../../src/recovery/index.js";

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

  test("marks starting runs as interrupted via running transition", async () => {
    seedSession("s2");
    await seedRunAtStatus("s2", "r2", "starting");

    const result = await recoverInterruptedRuns();

    const run = await WorkerRun.get("s2", "r2");
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
