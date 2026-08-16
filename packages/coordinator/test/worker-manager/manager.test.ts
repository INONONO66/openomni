import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerManager, type WorkerManager } from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const TEST_TRACE_ID = "trace-coordinator-test";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));

let manager: WorkerManager | undefined;

async function shutdownManager(): Promise<void> {
  await manager?.shutdown();
  manager = undefined;
}

afterEach(async () => {
  delete process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS;
  await shutdownManager();
});

function makeSocketDir(name: string): string {
  const socketDir = `/tmp/omo-wm-${name}-${process.pid}-${Date.now()}`;
  fs.mkdirSync(socketDir, { recursive: true });
  return socketDir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met before timeout");
}

describe("on-demand WorkerManager", () => {
  test("does not spawn workers before first dispatch and caps active processes", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("cap"),
        maxActiveWorkers: 2,
        idleShutdownMs: 1_000,
      },
      collectorPorts(),
    );

    expect(manager.stats()).toMatchObject({ workers: 0, ready: 0, maxActiveWorkers: 2 });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        manager?.deliver(`run-${index}`, {
          traceId: TEST_TRACE_ID,
          sessionId: `session-${index}`,
          delayMs: 40,
          prompt: "test",
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    expect(manager.stats().workers).toBeLessThanOrEqual(2);
  });

  test("reuses IPC worker affinity before idle shutdown", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("reuse"),
        maxActiveWorkers: 2,
        idleShutdownMs: 1_000,
      },
      collectorPorts(),
    );

    const first = (await manager.deliver("run-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "same-session",
      prompt: "test",
    })) as {
      workerId: string;
    };
    const second = (await manager.deliver("run-2", {
      traceId: TEST_TRACE_ID,
      sessionId: "same-session",
      prompt: "test",
    })) as {
      workerId: string;
    };

    expect(second.workerId).toBe(first.workerId);
    expect(manager.stats().workers).toBe(1);
  });

  test("creates a new worker under cap instead of stealing another session's idle slot", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("no-steal"),
        maxActiveWorkers: 2,
        idleShutdownMs: 1_000,
      },
      collectorPorts(),
    );

    const first = (await manager.deliver("run-a", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-a",
      prompt: "test",
    })) as {
      workerId: string;
    };
    const second = (await manager.deliver("run-b", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-b",
      prompt: "test",
    })) as {
      workerId: string;
    };

    expect(second.workerId).not.toBe(first.workerId);
    expect(manager.stats().workers).toBe(2);
  });

  test("shuts idle workers down, then recreates the session worker on demand", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("idle"),
        maxActiveWorkers: 1,
        idleShutdownMs: 25,
      },
      collectorPorts(),
    );

    const first = (await manager.deliver("run-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "resume-session",
      prompt: "test",
    })) as {
      workerId: string;
    };
    expect(manager.stats().workers).toBe(1);

    await waitFor(() => manager?.stats().workers === 0, 2_000);

    const second = (await manager.deliver("run-2", {
      traceId: TEST_TRACE_ID,
      sessionId: "resume-session",
      prompt: "test",
    })) as {
      workerId: string;
    };
    expect(second.workerId).not.toBe(first.workerId);
    expect(manager.stats().workers).toBe(1);
  });

  test("cancels a run before or during worker delivery", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("cancel"),
        maxActiveWorkers: 1,
        idleShutdownMs: 1_000,
      },
      collectorPorts(),
    );

    const dispatch = manager.deliver("run-cancel", {
      traceId: TEST_TRACE_ID,
      sessionId: "cancel-session",
      delayMs: 200,
      prompt: "test",
    });
    await waitFor(() => manager?.stats().activeRuns === 1);
    await waitFor(() => manager?.stats().ready === 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    await expect(manager.cancel("run-cancel")).resolves.toMatchObject({ cancelled: true });
    await expect(dispatch).resolves.toMatchObject({ status: "cancelled", runId: "run-cancel" });
  });

  test("accepts cancellation while a worker is still starting", async () => {
    process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS = "250";
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("startup-cancel"),
        maxActiveWorkers: 1,
        idleShutdownMs: 1_000,
        // The bootstrap-delay knob is a fixture key, off the production
        // allowlist; the test forwards it explicitly.
        extraWorkerEnvKeys: ["OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS"],
      },
      collectorPorts(),
    );

    const dispatch = manager.deliver("run-startup-cancel", {
      traceId: TEST_TRACE_ID,
      sessionId: "startup-cancel-session",
      prompt: "test",
    });
    await waitFor(() => manager?.stats().activeRuns === 1);
    expect(manager.stats().ready).toBe(0);

    await expect(manager.cancel("run-startup-cancel")).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(dispatch).resolves.toMatchObject({
      status: "cancelled",
      runId: "run-startup-cancel",
    });
  });

  test("rejects duplicate run ids across concurrent sessions before worker delivery", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("dup-diff"),
        maxActiveWorkers: 2,
        idleShutdownMs: 1_000,
      },
      collectorPorts(),
    );

    const first = manager.deliver("run-duplicate", {
      traceId: TEST_TRACE_ID,
      sessionId: "duplicate-session-a",
      delayMs: 100,
      prompt: "test",
    });
    await expect(
      manager.deliver("run-duplicate", {
        traceId: TEST_TRACE_ID,
        sessionId: "duplicate-session-b",
        delayMs: 100,
        prompt: "test",
      }),
    ).rejects.toThrow("run already active: run-duplicate");

    await expect(first).resolves.toMatchObject({
      runId: "run-duplicate",
      sessionId: "duplicate-session-a",
    });
  });

  test("rejects duplicate run ids for the same session while the original is active", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("dup-same"),
        maxActiveWorkers: 1,
        idleShutdownMs: 1_000,
      },
      collectorPorts(),
    );

    const first = manager.deliver("run-duplicate-same-session", {
      traceId: TEST_TRACE_ID,
      sessionId: "duplicate-session",
      delayMs: 100,
      prompt: "test",
    });
    await waitFor(() => manager?.stats().activeRuns === 1);

    await expect(
      manager.deliver("run-duplicate-same-session", {
        traceId: TEST_TRACE_ID,
        sessionId: "duplicate-session",
        prompt: "test",
      }),
    ).rejects.toThrow("run already active: run-duplicate-same-session");
    expect(manager.stats().activeRuns).toBe(1);

    await first;
  });

  test("duplicate run rejection preserves cancellation for the original run", async () => {
    process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS = "250";
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("dup-cancel"),
        maxActiveWorkers: 1,
        idleShutdownMs: 1_000,
        extraWorkerEnvKeys: ["OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS"],
      },
      collectorPorts(),
    );

    const original = manager.deliver("run-duplicate-cancel", {
      traceId: TEST_TRACE_ID,
      sessionId: "duplicate-cancel-session",
      prompt: "test",
    });
    await waitFor(() => manager?.stats().activeRuns === 1);

    await expect(
      manager.deliver("run-duplicate-cancel", {
        traceId: TEST_TRACE_ID,
        sessionId: "other-session",
        prompt: "test",
      }),
    ).rejects.toThrow("run already active: run-duplicate-cancel");
    await expect(manager.cancel("run-duplicate-cancel")).resolves.toMatchObject({
      cancelled: true,
      runId: "run-duplicate-cancel",
      sessionId: "duplicate-cancel-session",
    });
    await expect(original).resolves.toMatchObject({
      status: "cancelled",
      runId: "run-duplicate-cancel",
      sessionId: "duplicate-cancel-session",
    });
  });

  test("times out queued dispatches when all workers stay busy", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("queue-timeout"),
        maxActiveWorkers: 1,
        idleShutdownMs: 1_000,
        slotWaitTimeoutMs: 25,
      },
      collectorPorts(),
    );

    const first = manager.deliver("run-busy", {
      traceId: TEST_TRACE_ID,
      sessionId: "busy-session",
      delayMs: 200,
      prompt: "test",
    });
    await waitFor(() => manager?.stats().activeRuns === 1);

    await expect(
      manager.deliver("run-queued", {
        traceId: TEST_TRACE_ID,
        sessionId: "queued-session",
        prompt: "test",
      }),
    ).rejects.toThrow("worker slot wait timed out");
    await first;
  });

  test("serializes concurrent idle-slot reassignment at worker cap", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("reassign-race"),
        maxActiveWorkers: 1,
        idleShutdownMs: 1_000,
      },
      collectorPorts(),
    );

    await manager.deliver("run-a", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-a",
      prompt: "test",
    });

    const results = await Promise.allSettled([
      manager.deliver("run-b", {
        traceId: TEST_TRACE_ID,
        sessionId: "session-b",
        delayMs: 40,
        prompt: "test",
      }),
      manager.deliver("run-c", {
        traceId: TEST_TRACE_ID,
        sessionId: "session-c",
        delayMs: 40,
        prompt: "test",
      }),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(manager.stats().workers).toBeLessThanOrEqual(1);
  });

  test("cancels queued dispatch before worker delivery", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("queued-cancel"),
        maxActiveWorkers: 1,
        idleShutdownMs: 1_000,
      },
      collectorPorts(),
    );

    const first = manager.deliver("run-busy-cancel", {
      traceId: TEST_TRACE_ID,
      sessionId: "busy-session",
      delayMs: 200,
      prompt: "test",
    });
    await waitFor(() => manager?.stats().activeRuns === 1);

    const queued = manager.deliver("run-queued-cancel", {
      traceId: TEST_TRACE_ID,
      sessionId: "queued-session",
      prompt: "test",
    });
    await waitFor(() => manager?.stats().activeRuns === 2);

    await expect(manager.cancel("run-queued-cancel")).resolves.toMatchObject({
      cancelled: true,
      queued: true,
    });
    await expect(queued).resolves.toMatchObject({
      status: "cancelled",
      runId: "run-queued-cancel",
    });
    await first;
  });

  test("delivers live worker messages to an active run mailbox", async () => {
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("deliver"),
        maxActiveWorkers: 1,
        idleShutdownMs: 1_000,
      },
      collectorPorts(),
    );

    const dispatch = manager.deliver("run-deliver", {
      traceId: TEST_TRACE_ID,
      sessionId: "deliver-session",
      delayMs: 500,
      prompt: "test",
    });
    await waitFor(() => manager?.stats().ready === 1);

    let delivery: unknown;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      delivery = await manager.send(
        "deliver-session",
        "adjust your plan",
        TEST_TRACE_ID,
        "run-deliver",
      );
      if (
        delivery !== null &&
        typeof delivery === "object" &&
        (delivery as { accepted?: unknown }).accepted === true
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    // Pin (D11): the wire params carry the caller's trace, not the runId —
    // the fixture echoes what actually crossed the IPC boundary.
    expect(delivery).toMatchObject({ accepted: true, traceId: TEST_TRACE_ID });
    await dispatch;
  });
});
