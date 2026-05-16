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

  test("creates a private per-pool socket directory", () => {
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
    const result = await pool.dispatch("session-budget-1", "run-budget-1", {
      delayMs: 10,
      prompt: "test",
      budget: { maxWallTimeMs: 120_000 },
    });
    expect((result as Record<string, unknown>).accepted).toBe(true);
  });

  test("dispatch without budget defaults to timeout=330_000", async () => {
    const result = await pool.dispatch("session-budget-2", "run-budget-2", {
      delayMs: 10,
      prompt: "test",
    });
    expect((result as Record<string, unknown>).accepted).toBe(true);
  });

  test("workers inherit runtime environment updates", async () => {
    const previousDiscordToken = process.env.DISCORD_BOT_TOKEN;
    const previousAuthFile = process.env.OPENOMNI_AUTH_FILE;
    const previousHome = process.env.HOME;
    process.env.OPENOMNI_WORKER_ENV_FIXTURE = "runtime-value";
    process.env.OPENOMNI_AUTH_FILE = "/tmp/openomni-secret-auth.json";
    process.env.HOME = "/tmp/openomni-secret-home";
    process.env.DISCORD_BOT_TOKEN = "secret-token";
    const envSocketDir = `${socketDir}-env`;
    fs.mkdirSync(envSocketDir, { recursive: true });
    const envPool = createWorkerPool({
      size: 1,
      workerScript: WORKER_ENTRY,
      socketDir: envSocketDir,
    });
    try {
      await envPool.waitUntilReady(15_000);
      const result = await envPool.dispatch("session-env", "run-env", {
        prompt: "test",
        envName: "OPENOMNI_WORKER_ENV_FIXTURE",
      });
      expect((result as Record<string, unknown>).envValue).toBe("runtime-value");
      const secretResult = await envPool.dispatch("session-env", "run-secret", {
        prompt: "test",
        envName: "DISCORD_BOT_TOKEN",
      });
      expect((secretResult as Record<string, unknown>).envValue).toBeUndefined();
      const authTokenResult = await envPool.dispatch("session-env", "run-auth-token", {
        prompt: "test",
        envName: "OPENOMNI_WORKER_IPC_TOKEN",
      });
      expect((authTokenResult as Record<string, unknown>).envValue).toBeUndefined();
      const authFileResult = await envPool.dispatch("session-env", "run-auth-file", {
        prompt: "test",
        envName: "OPENOMNI_AUTH_FILE",
      });
      expect((authFileResult as Record<string, unknown>).envValue).toBeUndefined();
      const homeResult = await envPool.dispatch("session-env", "run-home", {
        prompt: "test",
        envName: "HOME",
      });
      expect((homeResult as Record<string, unknown>).envValue).toBeUndefined();
    } finally {
      await envPool.shutdown();
      delete process.env.OPENOMNI_WORKER_ENV_FIXTURE;
      if (previousAuthFile === undefined) {
        delete process.env.OPENOMNI_AUTH_FILE;
      } else {
        process.env.OPENOMNI_AUTH_FILE = previousAuthFile;
      }
      if (previousDiscordToken === undefined) {
        delete process.env.DISCORD_BOT_TOKEN;
      } else {
        process.env.DISCORD_BOT_TOKEN = previousDiscordToken;
      }
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });
});
