import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Operational } from "@openomni/protocol";
import {
  createWorkerManager,
  killWorkerForTest,
  type WorkerManager,
} from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const TEST_TRACE_ID = "trace-coordinator-test";
const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));

let manager: WorkerManager | undefined;

afterEach(async () => {
  await manager?.shutdown();
  manager = undefined;
});

function makeSocketDir(name: string): string {
  const socketDir = `/tmp/omo-pi-${name}-${process.pid}-${Date.now()}`;
  fs.mkdirSync(socketDir, { recursive: true });
  return socketDir;
}

type PoolInternals = {
  waiters: Array<{ resolve: () => void; reject: (error: Error) => void }>;
  slots: Map<number, { reserved: boolean; supervisor: unknown }>;
  reassignSlot(slot: unknown, sessionId: string): Promise<unknown>;
};

describe("worker pool internals", () => {
  test("clamping maxActiveWorkers publishes a warn instead of silently capping (#audit L7)", () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      { workerScript: WORKER_ENTRY, socketDir: makeSocketDir("clamp"), maxActiveWorkers: 99 },
      ports,
    );

    expect(manager.stats().maxActiveWorkers).toBe(10);
    const warn = ports.collected.find(
      (entry) =>
        entry.event.name === Operational.Warn.name &&
        (entry.data as { msg: string }).msg === "maxActiveWorkers clamped",
    )?.data as { context: { requested: number; effective: number } };
    expect(warn).toBeDefined();
    expect(warn.context).toEqual({ requested: 99, effective: 10 });
  });

  test("an in-range maxActiveWorkers publishes no clamp warn", () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      { workerScript: WORKER_ENTRY, socketDir: makeSocketDir("no-clamp"), maxActiveWorkers: 4 },
      ports,
    );

    expect(
      ports.collected.some(
        (entry) => (entry.data as { msg?: string }).msg === "maxActiveWorkers clamped",
      ),
    ).toBe(false);
  });

  test("killWorker on an idle slot wakes a queued waiter (#audit L5)", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("kill-wake"),
        maxActiveWorkers: 1,
        idleShutdownMs: 60_000,
      },
      collectorPorts(),
    );

    // Materialize slot 0 (idle after the run completes).
    await manager.deliver("run-kw-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-kw-1",
      prompt: "t",
    });

    const pool = manager as unknown as PoolInternals;
    let woken = false;
    pool.waiters.push({
      resolve: () => {
        woken = true;
      },
      reject: () => undefined,
    });

    killWorkerForTest(manager, 0);

    expect(woken).toBe(true);
    expect(manager.stats().workers).toBe(0);
  });

  test("a cancel the worker refuses resets the flag — the run must not settle 'cancelled'", async () => {
    manager = createWorkerManager(
      { workerScript: WORKER_ENTRY, socketDir: makeSocketDir("cancel-refused") },
      collectorPorts(),
    );
    const pool = manager as unknown as {
      activeRuns: Map<string, { cancelled: boolean; sessionId: string; slot: unknown }>;
    };

    const refusedRun = {
      sessionId: "session-refused",
      traceId: TEST_TRACE_ID,
      cancelled: false,
      slot: {
        supervisor: {
          isReady: () => true,
          cancel: async () => ({ cancelled: false, error: "run already finishing" }),
        },
      },
    };
    pool.activeRuns.set("run-refused", refusedRun as never);
    await expect(manager.cancel("run-refused")).resolves.toMatchObject({ cancelled: false });
    // RunSettled reads this flag after deliver resolves; a stale true would
    // inverse-mislabel the completed run as "cancelled" on the ledger.
    expect(refusedRun.cancelled).toBe(false);

    const failedRun = {
      sessionId: "session-failed",
      traceId: TEST_TRACE_ID,
      cancelled: false,
      slot: {
        supervisor: {
          isReady: () => true,
          cancel: async () => {
            throw new Error("cancel rpc timeout");
          },
        },
      },
    };
    pool.activeRuns.set("run-failed", failedRun as never);
    await expect(manager.cancel("run-failed")).rejects.toThrow("cancel rpc timeout");
    expect(failedRun.cancelled).toBe(false);

    const confirmedRun = {
      sessionId: "session-confirmed",
      traceId: TEST_TRACE_ID,
      cancelled: false,
      slot: {
        supervisor: {
          isReady: () => true,
          cancel: async () => ({ cancelled: true }),
        },
      },
    };
    pool.activeRuns.set("run-confirmed", confirmedRun as never);
    await expect(manager.cancel("run-confirmed")).resolves.toMatchObject({ cancelled: true });
    expect(confirmedRun.cancelled).toBe(true);

    pool.activeRuns.clear();
  });

  test("a throwing stop() during reassignment does not leak reserved=true (#audit L3)", async () => {
    manager = createWorkerManager(
      { workerScript: WORKER_ENTRY, socketDir: makeSocketDir("reassign-throw") },
      collectorPorts(),
    );
    const pool = manager as unknown as PoolInternals;

    const slot = {
      id: 0,
      ownerSessionId: "session-old",
      supervisor: {
        stop: async () => {
          throw new Error("stop failed");
        },
      },
      load: 0,
      reserved: false,
      idleTimer: null,
    };
    let woken = false;
    pool.waiters.push({
      resolve: () => {
        woken = true;
      },
      reject: () => undefined,
    });

    await expect(pool.reassignSlot(slot, "session-new")).rejects.toThrow("stop failed");

    expect(slot.reserved).toBe(false);
    expect(woken).toBe(true);
  });
});
