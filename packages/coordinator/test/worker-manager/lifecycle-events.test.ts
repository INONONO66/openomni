import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkerDeliveryError, WorkerDriver } from "@openomni/protocol";
import { createWorkerManager, type WorkerManager } from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));
const TEST_IDENTITY = {
  runtimeId: "runtime-lifecycle-events",
  principalId: "principal-lifecycle-events",
  bootstrap: { configEpoch: "test" },
} as const;

function fixturePrompt(fixture: Record<string, unknown> = {}): string {
  return JSON.stringify({ fixture, prompt: "test" });
}

let manager: WorkerManager | undefined;

afterEach(async () => {
  delete process.env.OPENOMNI_DELIVER_MARGIN_MS;
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
      {
        ...TEST_IDENTITY,
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("happy"),
        maxActiveWorkers: 1,
      },
      ports,
    );

    await manager.deliver("run-le-1", {
      sessionId: "session-le-1",
      prompt: fixturePrompt({ delayMs: 40 }),
    });

    const names = ports.collected.map((entry) => entry.event.name);
    const spawnedIndex = names.indexOf(WorkerDriver.Spawned.name);
    const readyIndex = names.indexOf(WorkerDriver.Ready.name);
    const deliveredIndex = names.indexOf(WorkerDriver.RunDelivered.name);
    const settledIndex = names.indexOf(WorkerDriver.RunSettled.name);
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
      {
        ...TEST_IDENTITY,
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("wall"),
        maxActiveWorkers: 1,
      },
      ports,
    );

    await expectDeliveryError(
      manager.deliver("run-le-wall", {
        sessionId: "session-le-wall",
        prompt: fixturePrompt({ delayMs: 30_000 }),
        budget: { maxWallTimeMs: 200 },
      }),
      "wall_time_exceeded",
    );

    const settled = ports.collected.find(
      (entry) => entry.event.name === WorkerDriver.RunSettled.name,
    )?.data as { outcome: string; runId: string };
    expect(settled).toMatchObject({ runId: "run-le-wall", outcome: "interrupted" });

    // The kill is real physics: the worker process exits (unplanned) and the
    // supervisor schedules a replacement.
    await waitFor(() =>
      ports.collected.some(
        (entry) =>
          entry.event.name === WorkerDriver.Exited.name &&
          (entry.data as { planned: boolean }).planned === false,
      ),
    );
    await waitFor(() =>
      ports.collected.some((entry) => entry.event.name === WorkerDriver.Restarted.name),
    );
  });

  test("queue saturation rejects with queue_full and records the event", async () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      {
        ...TEST_IDENTITY,
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("queue"),
        maxActiveWorkers: 1,
        maxQueuedDeliveries: 0,
      },
      ports,
    );

    const occupying = manager.deliver("run-le-q1", {
      sessionId: "session-le-q1",
      prompt: fixturePrompt({ delayMs: 400 }),
    });
    // Wait until the first run holds the only slot so the second one queues.
    await waitFor(() => manager?.stats().activeRuns === 1);

    await expectDeliveryError(
      manager.deliver("run-le-q2", { sessionId: "session-le-q2", prompt: "t" }),
      "queue_full",
    );
    const saturated = ports.collected.find(
      (entry) => entry.event.name === WorkerDriver.QueueSaturated.name,
    )?.data as { queued: number; maxQueuedDeliveries: number };
    expect(saturated).toMatchObject({ queued: 0, maxQueuedDeliveries: 0 });

    await occupying;
  });

  test("deliveries queued or arriving during shutdown reject with shutting_down", async () => {
    const ports = collectorPorts();
    manager = createWorkerManager(
      {
        ...TEST_IDENTITY,
        workerScript: WORKER_ENTRY,
        socketDir: makeSocketDir("stop"),
        maxActiveWorkers: 1,
        maxQueuedDeliveries: 5,
      },
      ports,
    );

    const occupying = manager.deliver("run-le-s1", {
      sessionId: "session-le-s1",
      prompt: fixturePrompt({ delayMs: 500 }),
    });
    await waitFor(() => manager?.stats().activeRuns === 1);
    const queued = manager.deliver("run-le-s2", { sessionId: "session-le-s2", prompt: "t" });
    // Give the queued delivery a beat to register as a slot waiter.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const stopping = manager.shutdown();
    await expectDeliveryError(queued, "shutting_down");
    await expectDeliveryError(
      manager.deliver("run-le-s3", { sessionId: "session-le-s3", prompt: "t" }),
      "shutting_down",
    );
    await Promise.allSettled([occupying]);
    await stopping;
    manager = undefined;
  });
});
