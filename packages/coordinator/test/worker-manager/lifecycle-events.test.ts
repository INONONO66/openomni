import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "@openomni/protocol";
import { WorkerDeliveryError } from "../../src/error";
import { createWorkerManager, type WorkerManager } from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const TEST_TRACE_ID = "trace-coordinator-test";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));

let manager: WorkerManager | undefined;

afterEach(async () => {
  delete process.env.OPENOMNI_DELIVER_MARGIN_MS;
  delete process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS;
  await manager?.shutdown();
  manager = undefined;
});

function makeSocketDir(name: string): string {
  const socketDir = `/tmp/omo-le-${name}-${process.pid}-${Date.now()}`;
  fs.mkdirSync(socketDir, { recursive: true });
  return socketDir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met before timeout");
}

type DeliveryErrorCode = InstanceType<typeof WorkerDeliveryError>["data"]["code"];

async function expectDeliveryError(
  promise: Promise<unknown>,
  code: DeliveryErrorCode,
): Promise<InstanceType<typeof WorkerDeliveryError>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerDeliveryError);
    const typed = error as InstanceType<typeof WorkerDeliveryError>;
    expect(typed.data.code).toBe(code);
    return typed;
  }
  throw new Error(`expected WorkerDeliveryError(${code}), delivery resolved instead`);
}

describe("worker driver lifecycle events (#462 §4)", () => {
  test("a delivered run leaves spawned → ready → delivered → settled on the sink", async () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      { workerScript: WORKER_ENTRY, socketDir: makeSocketDir("happy"), maxActiveWorkers: 1 },
      ports,
    );

    await manager.deliver("run-le-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-le-1",
      delayMs: 40,
      prompt: "t",
    });

    const names = ports.collected.map((entry) => entry.event.name);
    const spawnedIndex = names.indexOf(Worker.Events.Spawned.name);
    const readyIndex = names.indexOf(Worker.Events.Ready.name);
    const deliveredIndex = names.indexOf(Worker.Events.RunDelivered.name);
    const settledIndex = names.indexOf(Worker.Events.RunSettled.name);
    expect(spawnedIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(spawnedIndex);
    expect(deliveredIndex).toBeGreaterThan(readyIndex);
    expect(settledIndex).toBeGreaterThan(deliveredIndex);

    const settled = ports.collected[settledIndex]?.data as {
      runId: string;
      sessionId: string;
      outcome: string;
      durationMs: number;
    };
    expect(settled).toMatchObject({
      runId: "run-le-1",
      sessionId: "session-le-1",
      outcome: "completed",
    });
    expect(settled.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("wall-time ceiling kills the worker and settles the run as interrupted", async () => {
    process.env.OPENOMNI_DELIVER_MARGIN_MS = "300";
    const ports = collectorPorts();
    manager = createWorkerManager(
      { workerScript: WORKER_ENTRY, socketDir: makeSocketDir("wall"), maxActiveWorkers: 1 },
      ports,
    );

    await expectDeliveryError(
      manager.deliver("run-le-wall", {
        traceId: TEST_TRACE_ID,
        sessionId: "session-le-wall",
        delayMs: 30_000,
        budget: { maxWallTimeMs: 200 },
      }),
      "wall_time_exceeded",
    );

    const settled = ports.collected.find(
      (entry) => entry.event.name === Worker.Events.RunSettled.name,
    )?.data as { outcome: string; runId: string };
    expect(settled).toMatchObject({ runId: "run-le-wall", outcome: "interrupted" });

    // The kill is real physics: the worker process exits (unplanned) and the
    // supervisor schedules a replacement.
    await waitFor(() =>
      ports.collected.some(
        (entry) =>
          entry.event.name === Worker.Events.Exited.name &&
          (entry.data as { planned: boolean }).planned === false,
      ),
    );
    await waitFor(() =>
      ports.collected.some((entry) => entry.event.name === Worker.Events.Restarted.name),
    );
  });

  test("queue saturation rejects with queue_full and records the event", async () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("queue"),
        maxActiveWorkers: 1,
        maxQueuedDeliveries: 0,
      },
      ports,
    );

    const occupying = manager.deliver("run-le-q1", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-le-q1",
      delayMs: 400,
      prompt: "t",
    });
    // Wait until the first run holds the only slot so the second one queues.
    await waitFor(() => manager?.stats().activeRuns === 1);

    await expectDeliveryError(
      manager.deliver("run-le-q2", {
        traceId: TEST_TRACE_ID,
        sessionId: "session-le-q2",
        prompt: "t",
      }),
      "queue_full",
    );
    const saturated = ports.collected.find(
      (entry) => entry.event.name === Worker.Events.QueueSaturated.name,
    )?.data as { queued: number; maxQueuedDeliveries: number };
    expect(saturated).toMatchObject({ queued: 0, maxQueuedDeliveries: 0 });

    await occupying;
  });

  test("deliveries queued or arriving during shutdown reject with shutting_down", async () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("stop"),
        maxActiveWorkers: 1,
        maxQueuedDeliveries: 5,
      },
      ports,
    );

    const occupying = manager.deliver("run-le-s1", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-le-s1",
      delayMs: 500,
      prompt: "t",
    });
    await waitFor(() => manager?.stats().activeRuns === 1);
    const queued = manager.deliver("run-le-s2", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-le-s2",
      prompt: "t",
    });
    // Give the queued delivery a beat to register as a slot waiter.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const stopping = manager.shutdown();
    await expectDeliveryError(queued, "shutting_down");
    await expectDeliveryError(
      manager.deliver("run-le-s3", {
        traceId: TEST_TRACE_ID,
        sessionId: "session-le-s3",
        prompt: "t",
      }),
      "shutting_down",
    );
    await Promise.allSettled([occupying]);
    await stopping;
    manager = undefined;
  });

  test("a run cancelled while queued settles as cancelled on the ledger (#audit M4a)", async () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      { workerScript: WORKER_ENTRY, socketDir: makeSocketDir("cancel-q"), maxActiveWorkers: 1 },
      ports,
    );

    const occupying = manager.deliver("run-cq-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-cq-1",
      delayMs: 300,
      prompt: "t",
    });
    await waitFor(() => manager?.stats().activeRuns === 1);
    const queued = manager.deliver("run-cq-2", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-cq-2",
      prompt: "t",
    });
    await waitFor(() => manager?.stats().activeRuns === 2);

    await expect(manager.cancel("run-cq-2")).resolves.toMatchObject({ cancelled: true });
    await expect(queued).resolves.toMatchObject({ status: "cancelled", runId: "run-cq-2" });

    const settled = ports.collected.find(
      (entry) =>
        entry.event.name === Worker.Events.RunSettled.name &&
        (entry.data as { runId: string }).runId === "run-cq-2",
    )?.data;
    expect(settled).toMatchObject({
      runId: "run-cq-2",
      sessionId: "session-cq-2",
      outcome: "cancelled",
    });

    await occupying;
  });

  test("a run cancelled while its worker starts settles as cancelled (#audit M4a)", async () => {
    process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS = "250";
    const ports = collectorPorts();
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("cancel-s"),
        maxActiveWorkers: 1,
        // The bootstrap-delay knob is off the production allowlist; forward it.
        extraWorkerEnvKeys: ["OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS"],
      },
      ports,
    );

    const dispatch = manager.deliver("run-cs-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-cs-1",
      prompt: "t",
    });
    await waitFor(() => manager?.stats().activeRuns === 1);
    await expect(manager.cancel("run-cs-1")).resolves.toMatchObject({ cancelled: true });
    await expect(dispatch).resolves.toMatchObject({ status: "cancelled", runId: "run-cs-1" });

    const settled = ports.collected.find(
      (entry) => entry.event.name === Worker.Events.RunSettled.name,
    )?.data;
    expect(settled).toMatchObject({ runId: "run-cs-1", outcome: "cancelled" });
  });

  test("a mid-flight cancel settles as cancelled, not completed (#audit M4b/M4c)", async () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      { workerScript: WORKER_ENTRY, socketDir: makeSocketDir("cancel-m"), maxActiveWorkers: 1 },
      ports,
    );

    const dispatch = manager.deliver("run-cm-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-cm-1",
      delayMs: 300,
      prompt: "t",
    });
    // Cancel only after the run is actually in flight on a worker.
    await waitFor(() =>
      ports.collected.some((entry) => entry.event.name === Worker.Events.RunDelivered.name),
    );
    await expect(manager.cancel("run-cm-1")).resolves.toMatchObject({ cancelled: true });
    await dispatch;

    const settled = ports.collected.find(
      (entry) => entry.event.name === Worker.Events.RunSettled.name,
    )?.data;
    expect(settled).toMatchObject({ runId: "run-cm-1", outcome: "cancelled" });
  });

  test("shutdown with an in-flight delivery leaves no armed idle timers (#audit M3)", async () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      {
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("shutdown-timer"),
        maxActiveWorkers: 1,
        idleShutdownMs: 60_000,
      },
      ports,
    );

    const inflight = manager.deliver("run-st-1", {
      traceId: TEST_TRACE_ID,
      sessionId: "session-st-1",
      delayMs: 500,
      prompt: "t",
    });
    await waitFor(() =>
      ports.collected.some((entry) => entry.event.name === Worker.Events.RunDelivered.name),
    );

    // White-box: capture the slot objects before shutdown clears the map, so
    // a timer re-armed by the in-flight rejection is observable afterwards.
    const slots = [
      ...(manager as unknown as { slots: Map<number, { idleTimer: unknown }> }).slots.values(),
    ];
    expect(slots.length).toBeGreaterThan(0);

    const stopping = manager.shutdown();
    await Promise.allSettled([inflight]);
    await stopping;
    manager = undefined;

    for (const slot of slots) {
      expect(slot.idleTimer).toBeNull();
    }
  });
});
