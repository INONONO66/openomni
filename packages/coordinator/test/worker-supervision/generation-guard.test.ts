import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "@openomni/protocol";
import { WorkerSupervisor } from "../../src/worker-supervision/supervisor.js";

const FIXTURE = new URL("../harness/worker-fixture.ts", import.meta.url).pathname;

// White-box seam (same pattern as the pool's ensure-supervisor test): the
// generation counter is private, and the bug being pinned is exactly a stale
// loop reading the LIVE counter — so the test plays the crash-restart that
// re-mints it.
type SupervisorInternals = { generation: number; client: unknown };

let tempDir: string | undefined;
let supervisor: WorkerSupervisor | undefined;
let previousDelay: string | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
  if (previousDelay === undefined) {
    delete process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS;
  } else {
    process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS = previousDelay;
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startSupervisor(
  id: number,
  socketDir: string,
): {
  supervisor: WorkerSupervisor;
  internals: SupervisorInternals;
  readyEvents: unknown[];
} {
  const readyEvents: unknown[] = [];
  const created = new WorkerSupervisor({
    id,
    script: FIXTURE,
    socketDir,
    events: {
      publish(event, data) {
        if (event.name === Worker.Events.Ready.name) readyEvents.push(data);
      },
    },
    extraEnvKeys: ["OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS"],
  });
  supervisor = created;
  return {
    supervisor: created,
    internals: created as unknown as SupervisorInternals,
    readyEvents,
  };
}

test("a connect loop superseded before connecting never bootstraps", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "generation-guard-"));
  previousDelay = process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS;
  process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS = "0";

  const { supervisor: sup, internals, readyEvents } = startSupervisor(971, tempDir);
  // A crash-restart re-mints the generation while gen 1's loop is pending:
  // the stale loop must exit on its snapshot, not read the live counter.
  internals.generation += 1;

  await sleep(1_500);

  expect(sup.isReady()).toBe(false);
  expect(internals.client).toBeNull();
  expect(readyEvents).toHaveLength(0);
});

test("a connect loop superseded mid-bootstrap bails out instead of installing its client", async () => {
  tempDir = mkdtempSync(join(tmpdir(), "generation-guard-mid-"));
  previousDelay = process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS;
  // Long enough that the generation bump below lands while gen 1's loop is
  // sitting inside the bootstrap RPC, past the loop-condition check.
  process.env.OPENOMNI_WORKER_BOOTSTRAP_DELAY_MS = "1200";

  const { supervisor: sup, internals, readyEvents } = startSupervisor(972, tempDir);
  const socketPath = sup.socketPath;
  const deadline = Date.now() + 5_000;
  while (!existsSync(socketPath) && Date.now() < deadline) {
    await sleep(10);
  }
  expect(existsSync(socketPath)).toBe(true);
  // The loop polls the socket every 250ms and then enters the 1200ms
  // bootstrap call; bumping 500ms after the socket appears lands inside it.
  await sleep(500);
  internals.generation += 1;

  await sleep(1_800);

  expect(sup.isReady()).toBe(false);
  expect(internals.client).toBeNull();
  expect(readyEvents).toHaveLength(0);
});
