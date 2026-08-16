import { expect, test } from "bun:test";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createWorkerManager } from "../../src/worker-manager";
import { collectorPorts } from "../harness/ports";

const WORKER_ENTRY = fileURLToPath(new URL("../harness/worker-fixture.ts", import.meta.url));

// White-box pool access (same seam as the ensure-supervisor test):
// `scheduleIdleShutdown` is private, and the bug being pinned is a delivery
// settling AFTER shutdown() — `releaseLoadedSlot` fires from `deliver`'s
// finally block once the pool has already swept its timers and forgotten the
// slot, so we drive the private method directly with the settled slot.
type SettledSlot = {
  id: number;
  ownerSessionId: string;
  supervisor: null;
  load: number;
  reserved: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
};
type PoolInternals = { scheduleIdleShutdown(slot: SettledSlot): void };

test("a delivery settling after shutdown() does not re-arm an idle timer", async () => {
  const socketDir = `/tmp/omo-idle-stop-${process.pid}-${Date.now()}`;
  fs.mkdirSync(socketDir, { recursive: true });
  const manager = createWorkerManager(
    { workerScript: WORKER_ENTRY, socketDir, idleShutdownMs: 60_000 },
    collectorPorts(),
  );
  try {
    await manager.shutdown();

    const slot: SettledSlot = {
      id: 0,
      ownerSessionId: "settled-after-shutdown",
      supervisor: null,
      load: 0,
      reserved: false,
      idleTimer: null,
    };
    (manager as unknown as PoolInternals).scheduleIdleShutdown(slot);

    // Pin: no timer on a stopping pool — an armed one lives on a slot the
    // pool has already forgotten (shutdown cleared `slots`), holding the
    // process open until the idle window expires.
    expect(slot.idleTimer).toBeNull();
  } finally {
    fs.rmSync(socketDir, { recursive: true, force: true });
  }
});
