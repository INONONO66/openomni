import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Operational } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";
import { WorkerRunStateStore } from "../../src/worker-run/state-store";

/**
 * #510 D2b pin (a) — the worker-run store is a FROZEN legacy writer
 * (pending-ask/pending-interaction precedent): every write surface throws
 * the typed `WorkerRunFrozenError` (`data.code === "worker_run_frozen"`)
 * and persists nothing, while historical `worker_run_state` rows — seeded at
 * the adapter layer, exactly as pre-freeze rows persist on disk — keep
 * answering every read surface.
 */

function seedSession(id: string): void {
  Storage.get().session.set(id, {
    id,
    title: "test",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now(), updated: Date.now() },
    spawnDepth: 0,
  });
}

function seedFrozenRun(
  sessionId: string,
  runId: string,
  status: WorkerRunStateStore.Status = "running",
): void {
  const adapter = Storage.get().workerRunState;
  if (!adapter) throw new Error("workerRunState sub-adapter missing");
  adapter.create(sessionId, {
    runId,
    parentSessionId: "parent-sess",
    agentName: "worker",
    status,
    executorKind: "internal_chat_agent",
    title: "legacy run",
    prompt: "legacy prompt",
    assignedStepId: undefined,
    error: undefined,
  });
}

const OBSERVER_DRAINED = "observer-drained";

/**
 * Positive control for a negative assertion. `Bus.publish` dispatches every
 * observer in exactly one `queueMicrotask` (`packages/telemetry/src/bus.ts:38-49`)
 * and the queue drains completely before an awaiting continuation resumes, so
 * publishing a sentinel AFTER the frozen writes and awaiting its arrival in the
 * same observer proves two things a timer cannot: the observer is live, and the
 * queue drained past the point where any publish from those writes would have
 * been delivered. A bare timer proves only that some duration elapsed, so a
 * slow-but-real publish would still pass the `toEqual([])` below.
 */
async function observerDrained(): Promise<void> {
  Bus.publish(Operational.Events.Warn, {
    traceId: "trace-frozen-drain",
    time: Date.now(),
    component: OBSERVER_DRAINED,
    msg: "drain sentinel",
  });
  await new Promise((resolve) => queueMicrotask(resolve));
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Bus.reset();
  seedSession("sess-frozen");
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

function expectFrozen(thrown: unknown, method: WorkerRunStateStore.WriteMethod): void {
  if (!WorkerRunStateStore.FrozenError.isInstance(thrown)) {
    throw new Error(`expected the typed WorkerRunFrozenError, got: ${String(thrown)}`);
  }
  expect(thrown.data.code).toBe("worker_run_frozen");
  expect(thrown.data.method).toBe(method);
}

describe("WorkerRun freeze (#510 D2b)", () => {
  test("write surfaces throw the typed frozen error, persist nothing, publish nothing", async () => {
    seedFrozenRun("sess-frozen", "run-legacy-store", "starting");
    const events: string[] = [];
    Bus.observe((descriptor) => {
      events.push(descriptor.name);
    });

    let thrownCreate: unknown;
    try {
      WorkerRunStateStore.create("sess-frozen", {
        runId: "run-frozen-store-create",
        agentName: "worker",
        status: "queued",
        title: "t",
        prompt: "p",
      });
    } catch (error) {
      thrownCreate = error;
    }
    expectFrozen(thrownCreate, "create");
    expect(WorkerRunStateStore.get("sess-frozen", "run-frozen-store-create")).toBeUndefined();

    let thrownUpdate: unknown;
    try {
      WorkerRunStateStore.updateStatus("sess-frozen", "run-legacy-store", "running");
    } catch (error) {
      thrownUpdate = error;
    }
    expectFrozen(thrownUpdate, "updateStatus");

    const row = WorkerRunStateStore.get("sess-frozen", "run-legacy-store");
    if (!row) throw new Error("frozen row must stay readable");
    let thrownIfCurrent: unknown;
    try {
      WorkerRunStateStore.updateStatusIfCurrent(
        "sess-frozen",
        "run-legacy-store",
        { status: "starting", timeUpdated: row.timeUpdated },
        "running",
      );
    } catch (error) {
      thrownIfCurrent = error;
    }
    expectFrozen(thrownIfCurrent, "updateStatusIfCurrent");

    await observerDrained();
    // Only the drain sentinel arrived: the frozen writes published nothing,
    // and the observer is proven live rather than merely idle for a duration.
    expect(events).toEqual([Operational.Events.Warn.name]);
    expect(WorkerRunStateStore.get("sess-frozen", "run-legacy-store")?.status).toBe("starting");
  });

  test("legacy rows keep answering the get read surface after the freeze", () => {
    seedFrozenRun("sess-frozen", "run-read-1", "succeeded");
    seedFrozenRun("sess-frozen", "run-read-2", "waiting_input");

    const record = WorkerRunStateStore.get("sess-frozen", "run-read-1");
    expect(record?.runId).toBe("run-read-1");
    expect(record?.parentSessionId).toBe("parent-sess");
    expect(record?.status).toBe("succeeded");

    expect(WorkerRunStateStore.get("sess-frozen", "run-read-2")?.status).toBe("waiting_input");
  });
});
