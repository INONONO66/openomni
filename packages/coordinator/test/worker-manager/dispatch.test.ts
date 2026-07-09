import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerManager, type WorkerManager } from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));

const socketDir = `/tmp/omo-dp-${process.pid}`;

let manager: WorkerManager;

beforeAll(async () => {
  fs.mkdirSync(socketDir, { recursive: true });
  manager = createWorkerManager(
    { maxActiveWorkers: 4, workerScript: WORKER_ENTRY, socketDir },
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
        workerScript: WORKER_ENTRY,
        socketDir: defaultSocketDir,
      },
      collectorPorts(),
    );
    try {
      expect(defaultManager.getStats().maxActiveWorkers).toBe(10);
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
        manager.dispatch(sessionId, runId, { delayMs: 30, prompt: "test" }),
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
      await manager.dispatch(sessionId, runId, { delayMs: 50, prompt: "test" });
    }
    const seqMs = Date.now() - seqStart;

    const parStart = Date.now();
    await Promise.all(
      runs.map(({ sessionId, runId }) =>
        manager.dispatch(sessionId, runId, { delayMs: 50, prompt: "test" }),
      ),
    );
    const parMs = Date.now() - parStart;

    expect(parMs).toBeLessThan(seqMs);
  });

  test("getStats reflects on-demand worker limit", () => {
    const stats = manager.getStats();
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
    const result = await manager.dispatch("session-budget-1", "run-budget-1", {
      delayMs: 10,
      prompt: "test",
      budget: { maxWallTimeMs: 120_000 },
    });
    expect((result as Record<string, unknown>).accepted).toBe(true);
  });

  test("dispatch without budget defaults to timeout=330_000", async () => {
    const result = await manager.dispatch("session-budget-2", "run-budget-2", {
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
    const envManager = createWorkerManager(
      {
        maxActiveWorkers: 1,
        workerScript: WORKER_ENTRY,
        socketDir: envSocketDir,
      },
      collectorPorts(),
    );
    try {
      await envManager.waitUntilReady(15_000);
      const result = await envManager.dispatch("session-env", "run-env", {
        prompt: "test",
        envName: "OPENOMNI_WORKER_ENV_FIXTURE",
      });
      expect((result as Record<string, unknown>).envValue).toBe("runtime-value");
      const secretResult = await envManager.dispatch("session-env", "run-secret", {
        prompt: "test",
        envName: "DISCORD_BOT_TOKEN",
      });
      expect((secretResult as Record<string, unknown>).envValue).toBeUndefined();
      const authTokenResult = await envManager.dispatch("session-env", "run-auth-token", {
        prompt: "test",
        envName: "OPENOMNI_WORKER_IPC_TOKEN",
      });
      expect((authTokenResult as Record<string, unknown>).envValue).toBeUndefined();
      const authFileResult = await envManager.dispatch("session-env", "run-auth-file", {
        prompt: "test",
        envName: "OPENOMNI_AUTH_FILE",
      });
      expect((authFileResult as Record<string, unknown>).envValue).toBeUndefined();
      const homeResult = await envManager.dispatch("session-env", "run-home", {
        prompt: "test",
        envName: "HOME",
      });
      expect((homeResult as Record<string, unknown>).envValue).toBeUndefined();
    } finally {
      await envManager.shutdown();
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
