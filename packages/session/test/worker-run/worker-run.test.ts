import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ExecutionEvent, Subagent } from "@openomni/protocol";
import { Bus } from "../../src/bus/index";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";
import { WorkerRun } from "../../src/worker-run/index";

function seedSession(id: string): void {
  Storage.getAdapter().session.set(id, {
    id,
    title: "test",
    model: { providerID: "test", modelID: "test" },
    time: { created: Date.now(), updated: Date.now() },
    spawnDepth: 0,
  });
}

async function flushBus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  Storage.reset();
  Storage.initialize({ dbPath: ":memory:" });
  Bus.reset();
  seedSession("sess-1");
});

afterEach(() => {
  Storage.reset();
  Bus.reset();
});

describe("WorkerRun", () => {
  test("create and get round-trip", async () => {
    await WorkerRun.create("sess-1", {
      runId: "run-1",
      title: "worker task",
      prompt: "do the thing",
      assignedStepId: "step-1",
    });

    const run = await WorkerRun.get("sess-1", "run-1");
    expect(run).not.toBeUndefined();
    expect(run?.runId).toBe("run-1");
    expect(run?.sessionId).toBe("sess-1");
    expect(run?.title).toBe("worker task");
    expect(run?.prompt).toBe("do the thing");
    expect(run?.assignedStepId).toBe("step-1");
    expect(run?.status).toBe("queued");
    expect(run?.resumeCount).toBe(0);
    expect(run?.startedAt).toBeGreaterThan(0);
  });

  test("listBySession returns all runs", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "one", prompt: "a" });
    await WorkerRun.create("sess-1", { runId: "run-2", title: "two", prompt: "b" });

    const runs = await WorkerRun.listBySession("sess-1");
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.runId)).toEqual(["run-1", "run-2"]);
  });

  test("updateStatus validates transitions", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "one", prompt: "a" });

    expect(WorkerRun.updateStatus("sess-1", "run-1", "running")).rejects.toThrow(
      "Invalid worker run status transition",
    );
  });

  test("multiple status updates replay correctly", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "one", prompt: "a" });
    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await WorkerRun.updateStatus("sess-1", "run-1", "running");
    await WorkerRun.updateStatus("sess-1", "run-1", "waiting_input");
    await WorkerRun.updateStatus("sess-1", "run-1", "running", { lastMessageId: "msg-1" });
    await WorkerRun.updateStatus("sess-1", "run-1", "succeeded", { endedAt: 1234 });

    const run = await WorkerRun.get("sess-1", "run-1");
    expect(run).not.toBeUndefined();
    expect(run?.status).toBe("succeeded");
    expect(run?.resumeCount).toBe(1);
    expect(run?.lastMessageId).toBe("msg-1");
    expect(run?.endedAt).toBe(1234);
  });

  test("updateStatus publishes WorkerRunStarted when entering starting", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "one", prompt: "a" });

    const events: Array<{ payload: { sessionId: string; runId: string; title: string } }> = [];
    const unsubscribe = Bus.subscribe(Subagent.Events.WorkerRunStarted, (event) => {
      events.push(event);
    });

    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await flushBus();
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ sessionId: "sess-1", runId: "run-1", title: "one" });
  });

  test("updateStatus publishes WorkerRunCompleted when entering succeeded", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "one", prompt: "a" });
    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await WorkerRun.updateStatus("sess-1", "run-1", "running");

    const events: Array<{ payload: { sessionId: string; runId: string; status: string } }> = [];
    const unsubscribe = Bus.subscribe(Subagent.Events.WorkerRunCompleted, (event) => {
      events.push(event);
    });

    await WorkerRun.updateStatus("sess-1", "run-1", "succeeded", { endedAt: 1234 });
    await flushBus();
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ sessionId: "sess-1", runId: "run-1", status: "succeeded" });
  });

  test("updateStatus publishes WorkerRunFailed when entering failed with error", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "one", prompt: "a" });
    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await WorkerRun.updateStatus("sess-1", "run-1", "running");

    const events: Array<{ payload: { sessionId: string; runId: string; error?: string } }> = [];
    const unsubscribe = Bus.subscribe(Subagent.Events.WorkerRunFailed, (event) => {
      events.push(event);
    });

    await WorkerRun.updateStatus("sess-1", "run-1", "failed", {
      endedAt: 1234,
      error: "boom",
    });
    await flushBus();
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ sessionId: "sess-1", runId: "run-1", error: "boom" });
  });

  test("updateStatus does not duplicate lifecycle events for idempotent status writes", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "one", prompt: "a" });
    await WorkerRun.updateStatus("sess-1", "run-1", "starting");

    const events: unknown[] = [];
    const unsubscribe = Bus.subscribe(Subagent.Events.WorkerRunStarted, (event) => {
      events.push(event);
    });

    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await flushBus();
    unsubscribe();

    expect(events).toHaveLength(0);
  });

  test("all appended events are valid ExecutionEvent rows", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "test", prompt: "do it" });
    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await WorkerRun.updateStatus("sess-1", "run-1", "running");
    await WorkerRun.updateStatus("sess-1", "run-1", "waiting_input");
    await WorkerRun.updateStatus("sess-1", "run-1", "running", { lastMessageId: "msg-1" });
    await WorkerRun.updateStatus("sess-1", "run-1", "succeeded", { endedAt: 1234 });

    const adapter = Storage.getAdapter();
    const rows = adapter.eventLog?.replay("sess-1") ?? [];
    const events: ExecutionEvent[] = [];
    const invalidRows: string[] = [];

    for (const row of rows) {
      const parsed = ExecutionEvent.Schema.safeParse(JSON.parse(row.data));
      if (parsed.success) {
        events.push(parsed.data as ExecutionEvent);
      } else {
        invalidRows.push(row.type);
      }
    }

    expect(invalidRows).toHaveLength(0);
    expect(events.length).toBeGreaterThan(0);
    const types = events.map((e) => e.type);
    expect(types).toContain("worker_run_created");
    expect(types).toContain("worker_run_status_changed");
    expect(types).toContain("worker_run_completed");
  });

  test("replay skips malformed worker_run_created rows without throwing", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "test", prompt: "do it" });

    const adapter = Storage.getAdapter();
    adapter.eventLog?.append("sess-1", "worker_run_created", "invalid json {");

    const run = await WorkerRun.get("sess-1", "run-1");
    expect(run).not.toBeUndefined();
    expect(run?.status).toBe("queued");
  });

  test("replay skips malformed worker_run_status_changed rows without throwing", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "test", prompt: "do it" });
    await WorkerRun.updateStatus("sess-1", "run-1", "starting");

    const adapter = Storage.getAdapter();
    adapter.eventLog?.append("sess-1", "worker_run_status_changed", "invalid json {");

    const run = await WorkerRun.get("sess-1", "run-1");
    expect(run).not.toBeUndefined();
    expect(run?.status).toBe("starting");
  });

  test("replay skips malformed worker_run_completed rows without throwing", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "test", prompt: "do it" });
    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await WorkerRun.updateStatus("sess-1", "run-1", "running");

    const adapter = Storage.getAdapter();
    adapter.eventLog?.append("sess-1", "worker_run_completed", "invalid json {");

    const run = await WorkerRun.get("sess-1", "run-1");
    expect(run).not.toBeUndefined();
    expect(run?.status).toBe("running");
  });
});
