import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerPool, type WorkerPool } from "../../src/worker-pool";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));

const socketDir = `/tmp/omo-cr-${process.pid}`;

let pool: WorkerPool;

beforeAll(async () => {
  fs.mkdirSync(socketDir, { recursive: true });
  pool = createWorkerPool({ size: 1, workerScript: WORKER_ENTRY, socketDir });
  await pool.waitUntilReady(15_000);
}, 20_000);

afterAll(async () => {
  await pool.shutdown();
}, 10_000);

describe("worker pool crash recovery", () => {
  test("in-flight run fails with clear error when worker is killed", async () => {
    const dispatchPromise = pool.dispatch("crash-session", "crash-run-1", {
      delayMs: 500,
      prompt: "test",
    });

    await new Promise<void>((r) => setTimeout(r, 50));
    pool.killWorker(0);

    await expect(dispatchPromise).rejects.toThrow();
  }, 10_000);

  test("pool recovers after worker crash and resumes dispatching", async () => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (pool.getStats().ready > 0) break;
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    expect(pool.getStats().ready).toBeGreaterThan(0);

    const result = await pool.dispatch("recovery-session", "recovery-run-1", { prompt: "test" });
    expect((result as Record<string, unknown>).accepted).toBe(true);
  }, 15_000);
});
