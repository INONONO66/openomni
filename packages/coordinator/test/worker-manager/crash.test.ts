import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerManager, type WorkerManager } from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));
const TEST_IDENTITY = {
  runtimeId: "runtime-crash",
  principalId: "principal-crash",
  bootstrap: { configEpoch: "test" },
} as const;

function fixturePrompt(fixture: Record<string, unknown> = {}): string {
  return JSON.stringify({ fixture, prompt: "test" });
}

const socketDir = `/tmp/omo-cr-${process.pid}`;

let manager: WorkerManager;

beforeAll(async () => {
  fs.mkdirSync(socketDir, { recursive: true });
  manager = createWorkerManager(
    { ...TEST_IDENTITY, maxActiveWorkers: 1, workerScript: WORKER_ENTRY, socketDir },
    collectorPorts(),
  );
  await manager.waitUntilReady(15_000);
}, 20_000);

afterAll(async () => {
  await manager.shutdown();
}, 10_000);

describe("worker manager crash recovery", () => {
  test("in-flight run fails when worker is killed", async () => {
    const dispatchPromise = manager.deliver("crash-run-1", {
      sessionId: "crash-session",
      prompt: fixturePrompt({ delayMs: 500 }),
    });

    await new Promise<void>((r) => setTimeout(r, 50));
    manager.killWorker(0);

    let errorMessage: string | undefined;
    try {
      await dispatchPromise;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      errorMessage = error.message;
    }
    expect(errorMessage).toContain("restarted before run crash-run-1 was delivered");
  }, 10_000);

  test("manager recovers after worker crash and resumes dispatching", async () => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (manager.stats().ready > 0) break;
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    expect(manager.stats().ready).toBeGreaterThan(0);

    const result = await manager.deliver("recovery-run-1", {
      sessionId: "recovery-session",
      prompt: "test",
    });
    expect((result as Record<string, unknown>).status).toBe("succeeded");
  }, 15_000);
});
