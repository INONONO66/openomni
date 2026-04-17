import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerPool, type WorkerPool } from "../../src/worker-pool";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));

const socketDir = `/tmp/omo-dp-${process.pid}`;

let pool: WorkerPool;

beforeAll(async () => {
  fs.mkdirSync(socketDir, { recursive: true });
  pool = createWorkerPool({ size: 4, workerScript: WORKER_ENTRY, socketDir });
  await pool.waitUntilReady(15_000);
}, 20_000);

afterAll(async () => {
  await pool.shutdown();
}, 10_000);

describe("worker pool dispatch", () => {
  test("all 16 parallel dispatches succeed", async () => {
    const runs = Array.from({ length: 16 }, (_, i) => ({
      sessionId: `session-${i}`,
      runId: `run-${i}`,
    }));

    const results = await Promise.all(
      runs.map(({ sessionId, runId }) =>
        pool.dispatch(sessionId, runId, { delayMs: 30, prompt: "test" }),
      ),
    );

    expect(results).toHaveLength(16);
    for (const r of results) {
      expect((r as Record<string, unknown>).accepted).toBe(true);
    }
  });

  test("parallel dispatch is significantly faster than sequential", async () => {
    const runs = Array.from({ length: 4 }, (_, i) => ({
      sessionId: `perf-session-${i}`,
      runId: `perf-run-${i}`,
    }));

    const seqStart = Date.now();
    for (const { sessionId, runId } of runs) {
      await pool.dispatch(sessionId, runId, { delayMs: 50, prompt: "test" });
    }
    const seqMs = Date.now() - seqStart;

    const parStart = Date.now();
    await Promise.all(
      runs.map(({ sessionId, runId }) =>
        pool.dispatch(sessionId, runId, { delayMs: 50, prompt: "test" }),
      ),
    );
    const parMs = Date.now() - parStart;

    expect(parMs).toBeLessThan(seqMs);
  });

  test("getStats reflects pool configuration", () => {
    const stats = pool.getStats();
    expect(stats.workers).toBe(4);
    expect(stats.ready).toBe(4);
    expect(stats.active).toBe(4);
    expect(stats.idle).toBe(0);
  });
});
