import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkerRun as WorkerRunProtocol } from "@openomni/protocol";
import { Bus } from "../../src/bus/index";
import { Storage } from "../../src/storage/storage";
import "../../src/storage/initialize";
import { WorkerRun } from "../../src/worker-run/index";
import { WorkerRunStateStore } from "../../src/worker-run/state-store";

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
    expect(run?.executorKind).toBe("internal_chat_agent");
    expect(run?.status).toBe("queued");
    expect(run?.resumeCount).toBe(0);
    expect(run?.startedAt).toBeGreaterThan(0);

    const stored = WorkerRunStateStore.get("sess-1", "run-1");
    expect(stored).toMatchObject({
      runId: "run-1",
      sessionId: "sess-1",
      agentName: "worker",
      status: "queued",
      title: "worker task",
      prompt: "do the thing",
      assignedStepId: "step-1",
      executorKind: "internal_chat_agent",
    });
  });

  test("create and get round-trip executor kind", async () => {
    await WorkerRun.create("sess-1", {
      runId: "run-external",
      title: "external task",
      prompt: "call the external worker",
      executorKind: "external_api",
    });

    const run = await WorkerRun.get("sess-1", "run-external");
    const stored = WorkerRunStateStore.get("sess-1", "run-external");

    expect(run?.executorKind).toBe("external_api");
    expect(stored?.executorKind).toBe("external_api");
  });

  test("status updates preserve executor kind", async () => {
    await WorkerRun.create("sess-1", {
      runId: "run-external",
      title: "external task",
      prompt: "call the external worker",
      executorKind: "external_api",
    });

    await WorkerRun.updateStatus("sess-1", "run-external", "starting");
    await WorkerRun.updateStatus("sess-1", "run-external", "running");

    const run = await WorkerRun.get("sess-1", "run-external");
    const stored = WorkerRunStateStore.get("sess-1", "run-external");

    expect(run?.executorKind).toBe("external_api");
    expect(stored?.executorKind).toBe("external_api");
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

  test("multiple status updates persist through state store", async () => {
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

    const stored = WorkerRunStateStore.get("sess-1", "run-1");
    expect(stored?.status).toBe("succeeded");
    expect(stored?.resumeCount).toBe(1);
  });

  test("listByStatus returns state-store recovery results", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "one", prompt: "a" });
    await WorkerRun.create("sess-1", { runId: "run-2", title: "two", prompt: "b" });
    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await WorkerRun.updateStatus("sess-1", "run-1", "running");
    await WorkerRun.updateStatus("sess-1", "run-2", "starting");

    const running = await WorkerRun.listByStatus("running");
    const starting = await WorkerRun.listByStatus("starting");

    expect(running.map((run) => run.runId)).toEqual(["run-1"]);
    expect(starting.map((run) => run.runId)).toEqual(["run-2"]);
  });

  test("updateStatus publishes WorkerRunStarted when entering starting", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "one", prompt: "a" });

    const events: Array<{ payload: { sessionId: string; runId: string; title: string } }> = [];
    const unsubscribe = Bus.subscribe(WorkerRunProtocol.Events.Started, (event) => {
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
    const unsubscribe = Bus.subscribe(WorkerRunProtocol.Events.Completed, (event) => {
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
    const unsubscribe = Bus.subscribe(WorkerRunProtocol.Events.Failed, (event) => {
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
    const unsubscribe = Bus.subscribe(WorkerRunProtocol.Events.Started, (event) => {
      events.push(event);
    });

    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await flushBus();
    unsubscribe();

    expect(events).toHaveLength(0);
  });

  test("WorkerRun state changes do not append legacy event rows", async () => {
    await WorkerRun.create("sess-1", { runId: "run-1", title: "test", prompt: "do it" });
    await WorkerRun.updateStatus("sess-1", "run-1", "starting");
    await WorkerRun.updateStatus("sess-1", "run-1", "running");
    await WorkerRun.updateStatus("sess-1", "run-1", "waiting_input");
    await WorkerRun.updateStatus("sess-1", "run-1", "running", { lastMessageId: "msg-1" });
    await WorkerRun.updateStatus("sess-1", "run-1", "succeeded", { endedAt: 1234 });

    expect(Object.hasOwn(Storage.getAdapter(), "eventLog")).toBe(false);
  });
});
