import { describe, test, expect, afterEach } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerManager, type WorkerManager } from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));
const socketDir = `/tmp/omo-ensure-${process.pid}`;

// White-box pool access (same seam the crash test reaches through
// `killWorkerForTest`): `ensureSupervisor` is private and constructs a real
// supervisor, so we drive it directly with an injected slot.
type FakeSupervisor = { isActive: () => boolean; dispose: () => void };
type PoolInternals = {
  ensureSupervisor(slot: unknown): FakeSupervisor;
  slots: Map<number, unknown>;
};

describe("ensureSupervisor replacement safety (#QB1)", () => {
  const created: WorkerManager[] = [];

  afterEach(async () => {
    for (const m of created.splice(0)) await m.shutdown();
  });

  test("disposes the existing inactive supervisor before replacing it", () => {
    fs.mkdirSync(socketDir, { recursive: true });
    const manager = createWorkerManager(
      { maxActiveWorkers: 1, workerScript: WORKER_ENTRY, socketDir },
      collectorPorts(),
    );
    created.push(manager);
    const pool = manager as unknown as PoolInternals;

    let disposeCalls = 0;
    // A supervisor that crashed and is sitting in restart backoff: inactive,
    // but its internal restart timer is still armed. Replacing it without
    // disposing orphans that timer (it re-spawns forever) and double-spawns
    // on the slot's single socket path.
    const staleSupervisor = {
      isActive: () => false,
      dispose: () => {
        disposeCalls += 1;
      },
    };
    const slot = {
      id: 0,
      ownerSessionId: "s",
      supervisor: staleSupervisor,
      load: 1,
      reserved: false,
      idleTimer: null,
    };
    pool.slots.set(0, slot);

    const next = pool.ensureSupervisor(slot);
    try {
      expect(disposeCalls).toBe(1);
      expect(slot.supervisor).toBe(next);
      expect(slot.supervisor).not.toBe(staleSupervisor);
    } finally {
      // Kill the real supervisor `ensureSupervisor` spawned.
      next.dispose();
    }
  });
});
