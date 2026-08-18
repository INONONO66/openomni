import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  Storage.getAdapter().session.set(id, {
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
  const adapter = Storage.getAdapter().workerRunState;
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

async function flushBus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

    await flushBus();
    expect(events).toEqual([]);
    expect(WorkerRunStateStore.get("sess-frozen", "run-legacy-store")?.status).toBe("starting");
  });

  test("legacy rows keep answering every read surface after the freeze", () => {
    seedFrozenRun("sess-frozen", "run-read-1", "succeeded");
    seedFrozenRun("sess-frozen", "run-read-2", "waiting_input");

    const record = WorkerRunStateStore.get("sess-frozen", "run-read-1");
    expect(record?.runId).toBe("run-read-1");
    expect(record?.parentSessionId).toBe("parent-sess");
    expect(record?.status).toBe("succeeded");

    expect(WorkerRunStateStore.listBySession("sess-frozen")).toHaveLength(2);
    expect(WorkerRunStateStore.listByStatus("waiting_input").map((run) => run.runId)).toContain(
      "run-read-2",
    );
  });
});
