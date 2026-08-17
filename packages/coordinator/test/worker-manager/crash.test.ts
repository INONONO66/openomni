import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkerDeliveryError } from "@openomni/protocol";
import {
  createWorkerManager,
  killWorkerForTest,
  type WorkerManager,
} from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const TEST_TRACE_ID = "trace-coordinator-test";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));

const socketDir = `/tmp/omo-cr-${process.pid}`;

let manager: WorkerManager;

beforeAll(() => {
  fs.mkdirSync(socketDir, { recursive: true });
  manager = createWorkerManager(
    { maxActiveWorkers: 1, workerScript: WORKER_ENTRY, socketDir },
    collectorPorts(),
  );
  // No waitUntilReady here (#audit L1): it is a documented no-op on a fresh
  // on-demand manager — no slots exist until the first delivery.
}, 20_000);

afterAll(async () => {
  await manager.shutdown();
}, 10_000);

describe("worker manager crash recovery", () => {
  test("in-flight run fails when worker is killed", async () => {
    const dispatchPromise = manager.deliver("crash-run-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "crash-session",
      delayMs: 500,
      prompt: "test",
    });

    await new Promise<void>((r) => setTimeout(r, 50));
    killWorkerForTest(manager, 0);

    // Typed-rejection contract (#audit M6): branch on data.code, not message
    // text — the crash surfaces as the worker_restarted generation guard.
    let caught: unknown;
    try {
      await dispatchPromise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkerDeliveryError);
    expect((caught as InstanceType<typeof WorkerDeliveryError>).data).toMatchObject({
      code: "worker_restarted",
      runId: "crash-run-1",
    });
  }, 10_000);

  test("manager recovers after worker crash and resumes dispatching", async () => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (manager.stats().ready > 0) break;
      await new Promise<void>((r) => setTimeout(r, 100));
    }

    expect(manager.stats().ready).toBeGreaterThan(0);

    const result = await manager.deliver("recovery-run-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "recovery-session",
      prompt: "test",
    });
    expect((result as Record<string, unknown>).accepted).toBe(true);
  }, 15_000);
});
