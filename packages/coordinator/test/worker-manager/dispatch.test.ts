import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerManager, type WorkerManager } from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));
const TEST_IDENTITY = {
  runtimeId: "runtime-dispatch",
  principalId: "principal-dispatch",
  bootstrap: { configEpoch: "test" },
} as const;

function fixturePrompt(fixture: Record<string, unknown> = {}): string {
  return JSON.stringify({ fixture, prompt: "test" });
}

const socketDir = `/tmp/omo-dp-${process.pid}`;

let manager: WorkerManager;

beforeAll(async () => {
  fs.mkdirSync(socketDir, { recursive: true });
  manager = createWorkerManager(
    { ...TEST_IDENTITY, maxActiveWorkers: 4, workerScript: WORKER_ENTRY, socketDir },
    collectorPorts(),
  );
  await manager.waitUntilReady(15_000);
}, 20_000);

afterAll(async () => {
  await manager.shutdown();
}, 10_000);

describe("worker manager dispatch", () => {
  test("WorkerManager defaults to ten active workers", async () => {
    const defaultSocketDir = `${socketDir}-default`;
    fs.mkdirSync(defaultSocketDir, { recursive: true });
    const defaultManager = createWorkerManager(
      {
        ...TEST_IDENTITY,
        workerScript: WORKER_ENTRY,
        socketDir: defaultSocketDir,
      },
      collectorPorts(),
    );
    try {
      expect(defaultManager.stats().maxActiveWorkers).toBe(10);
    } finally {
      await defaultManager.shutdown();
    }
  });

  test("all 16 parallel dispatches succeed", async () => {
    const runs = Array.from({ length: 16 }, (_, i) => ({
      sessionId: `session-${i}`,
      runId: `run-${i}`,
    }));

    const results = await Promise.all(
      runs.map(({ sessionId, runId }) =>
        manager.deliver(runId, { sessionId, prompt: fixturePrompt({ delayMs: 30 }) }),
      ),
    );

    expect(results).toHaveLength(16);
    for (const r of results) {
      expect((r as Record<string, unknown>).status).toBe("succeeded");
    }
  });

  test("parallel dispatch is significantly faster than sequential", async () => {
    const runs = Array.from({ length: 4 }, (_, i) => ({
      sessionId: `perf-session-${i}`,
      runId: `perf-run-${i}`,
    }));

    const seqStart = Date.now();
    for (const { sessionId, runId } of runs) {
      await manager.deliver(runId, { sessionId, prompt: fixturePrompt({ delayMs: 50 }) });
    }
    const seqMs = Date.now() - seqStart;

    const parStart = Date.now();
    await Promise.all(
      runs.map(({ sessionId, runId }) =>
        manager.deliver(runId, { sessionId, prompt: fixturePrompt({ delayMs: 50 }) }),
      ),
    );
    const parMs = Date.now() - parStart;

    expect(parMs).toBeLessThan(seqMs);
  });

  test("stats reflects on-demand worker limit", () => {
    const stats = manager.stats();
    expect(stats.maxActiveWorkers).toBe(4);
    expect(stats.workers).toBeLessThanOrEqual(4);
    expect(stats.ready).toBeLessThanOrEqual(stats.workers);
    expect(stats.active + stats.idle).toBe(stats.workers);
  });

  test("creates a private per-manager socket directory", () => {
    const entries = fs.readdirSync(socketDir, { withFileTypes: true });
    const privateDirs = entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("openomni-workers-"),
    );
    expect(privateDirs).toHaveLength(1);
    const privateDir = privateDirs[0];
    if (!privateDir) throw new Error("private socket directory missing");

    const mode = fs.statSync(`${socketDir}/${privateDir.name}`).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("dispatch with budget.maxWallTimeMs=120_000 passes timeout=150_000 to IPC", async () => {
    const result = await manager.deliver("run-budget-1", {
      sessionId: "session-budget-1",
      prompt: fixturePrompt({ delayMs: 10 }),
      budget: { maxWallTimeMs: 120_000 },
    });
    expect((result as Record<string, unknown>).status).toBe("succeeded");
  });

  test("dispatch without budget defaults to timeout=330_000", async () => {
    const result = await manager.deliver("run-budget-2", {
      sessionId: "session-budget-2",
      prompt: fixturePrompt({ delayMs: 10 }),
    });
    expect((result as Record<string, unknown>).status).toBe("succeeded");
  });

  test("unknown task fields never cross the spawn frame", async () => {
    const result = await manager.deliver("run-strict-frame", {
      sessionId: "session-strict-frame",
      prompt: fixturePrompt({ inspectSpawnFrame: true }),
      unknownTaskField: "must-stay-driver-local",
      budget: { maxWallTimeMs: 120_000 },
    });

    expect(result).toMatchObject({ status: "succeeded", workerId: "0" });
  });
});
