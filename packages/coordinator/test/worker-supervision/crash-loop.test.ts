import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Operational, Worker } from "@openomni/protocol";
import { WorkerSupervisor } from "../../src/worker-supervision/supervisor";
import { MAX_CONSECUTIVE_FAST_CRASHES } from "../../src/worker-supervision/supervisor-process";
import { collectorPorts } from "../harness/ports";

const NEVER_LISTENING_ENTRY = fileURLToPath(
  new URL("../harness/never-listening-worker-fixture.ts", import.meta.url),
);
const CRASHING_ENTRY = fileURLToPath(
  new URL("../harness/crashing-worker-fixture.ts", import.meta.url),
);

let supervisor: WorkerSupervisor | undefined;

afterEach(async () => {
  delete process.env.OPENOMNI_WORKER_CONNECT_TIMEOUT_MS;
  delete process.env.OPENOMNI_WORKER_RESTART_BASE_DELAY_MS;
  supervisor?.dispose();
  supervisor = undefined;
});

function makeSocketDir(name: string): string {
  const socketDir = `/tmp/omo-cl-${name}-${process.pid}-${Date.now()}`;
  fs.mkdirSync(socketDir, { recursive: true });
  return socketDir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met before timeout");
}

describe("zombie supervisor prevention (#audit H1)", () => {
  test("a worker that never serves IPC is killed at the connect deadline", async () => {
    process.env.OPENOMNI_WORKER_CONNECT_TIMEOUT_MS = "400";
    // Keep the post-kill restart cadence tight so dispose() in afterEach
    // reliably wins against a pending respawn.
    process.env.OPENOMNI_WORKER_RESTART_BASE_DELAY_MS = "50";
    const ports = collectorPorts();
    supervisor = new WorkerSupervisor({
      id: 0,
      script: NEVER_LISTENING_ENTRY,
      events: ports.events,
      socketDir: makeSocketDir("zombie"),
    });

    // The supervisor must ledger the deadline failure and KILL the process:
    // an unplanned Exited event is the proof the zombie did not linger with
    // running=true / isReady()=false (the old wedge).
    await waitFor(() =>
      ports.collected.some(
        (entry) =>
          entry.event.name === Operational.Events.Warn.name &&
          (entry.data as { msg: string }).msg ===
            "worker IPC connect failed within deadline; killing worker",
      ),
    );
    await waitFor(() =>
      ports.collected.some(
        (entry) =>
          entry.event.name === Worker.Events.Exited.name &&
          (entry.data as { planned: boolean }).planned === false,
      ),
    );
  });
});

describe("crash-loop circuit breaker (#audit M2)", () => {
  test("an instantly-crashing worker trips the breaker and stops respawning", async () => {
    process.env.OPENOMNI_WORKER_RESTART_BASE_DELAY_MS = "10";
    const ports = collectorPorts();
    supervisor = new WorkerSupervisor({
      id: 1,
      script: CRASHING_ENTRY,
      events: ports.events,
      socketDir: makeSocketDir("crash-loop"),
    });

    const spawnedCount = () =>
      ports.collected.filter((entry) => entry.event.name === Worker.Events.Spawned.name).length;

    await waitFor(
      () =>
        ports.collected.some(
          (entry) =>
            entry.event.name === Operational.Events.Warn.name &&
            (entry.data as { msg: string }).msg === "worker is crash-looping; restarts suspended",
        ),
      15_000,
    );

    // Initial spawn + MAX_CONSECUTIVE_FAST_CRASHES restart attempts, then stop.
    expect(spawnedCount()).toBe(MAX_CONSECUTIVE_FAST_CRASHES + 1);
    expect(supervisor.isActive()).toBe(false);

    // The breaker is terminal for this supervisor: no further spawns appear.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(spawnedCount()).toBe(MAX_CONSECUTIVE_FAST_CRASHES + 1);
  });
});
