import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";
import { WorkerRunStateStore } from "../../src/worker-run/state-store";

function seedSession(id: string): void {
  const now = Date.now();
  Storage.getAdapter().session.set(id, {
    id,
    title: `Session ${id}`,
    model: { providerID: "test", modelID: "test" },
    time: { created: now, updated: now },
    spawnDepth: 0,
  });
}

function makeRun(
  overrides: Partial<WorkerRunStateStore.CreateRecord> = {},
): WorkerRunStateStore.CreateRecord {
  return {
    runId: "run-1",
    parentSessionId: "parent-session",
    agentName: "worker",
    status: "queued",
    title: "worker task",
    prompt: "do the thing",
    assignedStepId: "step-1",
    ...overrides,
  };
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  seedSession("sess-1");
  seedSession("sess-2");
});

afterEach(() => {
  Storage.reset();
});

describe("WorkerRunStateStore", () => {
  test("create and get round-trip worker run state", () => {
    WorkerRunStateStore.create("sess-1", makeRun());

    const run = WorkerRunStateStore.get("sess-1", "run-1");

    expect(run).toMatchObject({
      runId: "run-1",
      sessionId: "sess-1",
      parentSessionId: "parent-session",
      agentName: "worker",
      status: "queued",
      title: "worker task",
      prompt: "do the thing",
      resumeCount: 0,
      assignedStepId: "step-1",
    });
    expect(run?.timeCreated).toBeGreaterThan(0);
    expect(run?.timeUpdated).toBe(run?.timeCreated);
  });

  test("listBySession returns session-scoped runs in creation order", () => {
    WorkerRunStateStore.create("sess-1", makeRun({ runId: "run-1", title: "one" }));
    WorkerRunStateStore.create("sess-1", makeRun({ runId: "run-2", title: "two" }));
    WorkerRunStateStore.create("sess-2", makeRun({ runId: "run-3", title: "three" }));

    const runs = WorkerRunStateStore.listBySession("sess-1");

    expect(runs.map((run) => run.runId)).toEqual(["run-1", "run-2"]);
  });

  test("updateStatus enforces valid transitions and updates timestamp", () => {
    WorkerRunStateStore.create("sess-1", makeRun({ timeCreated: 100, timeUpdated: 100 }));

    WorkerRunStateStore.updateStatus("sess-1", "run-1", "starting");
    WorkerRunStateStore.updateStatus("sess-1", "run-1", "running");

    const run = WorkerRunStateStore.get("sess-1", "run-1");
    expect(run?.status).toBe("running");
    expect(run?.timeUpdated).toBeGreaterThan(100);
  });

  test("updateStatus rejects invalid transitions", () => {
    WorkerRunStateStore.create("sess-1", makeRun());

    expect(() => WorkerRunStateStore.updateStatus("sess-1", "run-1", "running")).toThrow(
      "Invalid worker run status transition",
    );
  });

  test("updateStatus increments resume count when resuming from input wait", () => {
    WorkerRunStateStore.create("sess-1", makeRun());
    WorkerRunStateStore.updateStatus("sess-1", "run-1", "starting");
    WorkerRunStateStore.updateStatus("sess-1", "run-1", "running");
    WorkerRunStateStore.updateStatus("sess-1", "run-1", "waiting_input");
    WorkerRunStateStore.updateStatus("sess-1", "run-1", "running");

    const run = WorkerRunStateStore.get("sess-1", "run-1");
    expect(run?.resumeCount).toBe(1);
  });

  test("listByStatus supports recovery queries", () => {
    WorkerRunStateStore.create("sess-1", makeRun({ runId: "run-1" }));
    WorkerRunStateStore.create("sess-1", makeRun({ runId: "run-2" }));
    WorkerRunStateStore.create("sess-2", makeRun({ runId: "run-3" }));
    WorkerRunStateStore.updateStatus("sess-1", "run-1", "starting");
    WorkerRunStateStore.updateStatus("sess-1", "run-1", "running");
    WorkerRunStateStore.updateStatus("sess-1", "run-2", "starting");
    WorkerRunStateStore.updateStatus("sess-2", "run-3", "starting");
    WorkerRunStateStore.updateStatus("sess-2", "run-3", "running");
    WorkerRunStateStore.updateStatus("sess-2", "run-3", "failed", { error: "boom" });

    expect(WorkerRunStateStore.listByStatus("running").map((run) => run.runId)).toEqual(["run-1"]);
    expect(WorkerRunStateStore.listByStatus("starting").map((run) => run.runId)).toEqual(["run-2"]);
    expect(WorkerRunStateStore.listByStatus("failed")[0].error).toBe("boom");
  });

  test("session deletion cascades worker run state rows", () => {
    WorkerRunStateStore.create("sess-1", makeRun({ runId: "run-1" }));

    Storage.getAdapter().session.remove("sess-1");

    expect(WorkerRunStateStore.get("sess-1", "run-1")).toBeUndefined();
    expect(WorkerRunStateStore.listByStatus("queued")).toHaveLength(0);
  });
});
