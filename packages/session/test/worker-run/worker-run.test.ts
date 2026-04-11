import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Storage } from "../../src/storage/storage";
import { WorkerRun } from "../../src/worker-run/index";

beforeEach(() => {
  Storage.reset();
});

afterEach(() => {
  Storage.reset();
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
    expect(run!.runId).toBe("run-1");
    expect(run!.sessionId).toBe("sess-1");
    expect(run!.title).toBe("worker task");
    expect(run!.prompt).toBe("do the thing");
    expect(run!.assignedStepId).toBe("step-1");
    expect(run!.status).toBe("queued");
    expect(run!.resumeCount).toBe(0);
    expect(run!.startedAt).toBeGreaterThan(0);
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
    expect(run!.status).toBe("succeeded");
    expect(run!.resumeCount).toBe(1);
    expect(run!.lastMessageId).toBe("msg-1");
    expect(run!.endedAt).toBe(1234);
  });
});
