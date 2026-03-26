import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Session } from "@openomni/session";
import type { Sink } from "@openomni/protocol";
import { TaskManager } from "../../../src/legacy/task/manager";
import { TaskStorage } from "../../../src/legacy/task/storage";
import { type Task } from "../../../src/legacy/task/types";
import { Scheduler } from "../../../src/legacy/trigger/scheduler";
import { FilesystemWatcher } from "../../../src/legacy/trigger/watcher";
import { Router, Dispatcher, Envelope } from "../../../src/legacy/dispatch";
import { RunWorker } from "../../../src/legacy/worker/run/run-worker";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function createTask(overrides: Partial<Task.CreateInput> = {}): Task.Info {
  return TaskManager.create({
    title: "Integration Task",
    owner: { type: "user", id: "user-1" },
    triggers: [{ id: "manual-1", type: "manual" }],
    policy: { permission: "notify" },
    ...overrides,
  });
}

function createTextMessage(sink: Sink, text: string): void {
  sink.onMessage({
    info: {
      id: crypto.randomUUID(),
      sessionID: "integration-session",
      role: "assistant",
      time: {
        created: Date.now(),
        completed: Date.now(),
      },
      parentID: crypto.randomUUID(),
      modelID: "test-model",
      providerID: "test-provider",
      agent: "test-agent",
      path: {
        cwd: process.cwd(),
        root: process.cwd(),
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        id: crypto.randomUUID(),
        sessionID: "integration-session",
        messageID: "integration-message",
        type: "text",
        text,
      },
    ],
  });
}

describe("P7-3 E2E integration flows", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Session.storage.clear();
    Router.clear();
    Scheduler.clear();
  });

  afterEach(() => {
    Router.clear();
    Scheduler.clear();
    Session.storage.clear();
  });

  it("manual trigger flow: create -> trigger -> orchestrate -> summarize -> cleanup", async () => {
    const task = createTask({
      triggers: [{ id: "manual-1", type: "manual" }],
    });

    const triggerResult = await TaskManager.trigger(task.id, {
      triggerId: "manual-1",
      type: "manual",
      occurredAt: Date.now(),
    });

    expect("runId" in triggerResult).toBe(true);
    if (!("runId" in triggerResult)) return;

    const orchestration = await RunWorker.run(
      {
        taskId: task.id,
        runId: triggerResult.runId,
        maxRetries: 0,
      },
      {
        llm: {
          run: async (_input, sink) => {
            createTextMessage(sink, "Manual trigger orchestration completed.");
            return { type: "stop" as const };
          },
        },
        input: {},
      },
    );

    expect(orchestration.success).toBe(true);
    expect(orchestration.summary).toContain("Manual trigger orchestration completed.");

    const run = TaskManager.getRun(triggerResult.runId);
    expect(run?.status).toBe("done");

    if (run) {
      expect(Session.get(run.sessionKey)).toBeUndefined();
    }
  });

  it("scheduled trigger flow: cron registration -> scheduler fire -> run created -> complete", async () => {
    const task = createTask({
      triggers: [{ id: "cron-1", type: "cron", expr: "* * * * *" }],
    });

    const originalNow = Date.now;
    Date.now = () => new Date("2026-01-01T00:00:59.900Z").getTime();
    Scheduler.register(task);
    Date.now = originalNow;

    await sleep(220);

    const runs = TaskManager.listRuns(task.id);
    expect(runs.length).toBeGreaterThan(0);

    const run = runs[0]!;
    expect(run.trigger.type).toBe("cron");
    expect(run.status).toBe("scheduled");

    const orchestration = await RunWorker.run(
      {
        taskId: task.id,
        runId: run.runId,
        maxRetries: 0,
      },
      {
        llm: {
          run: async (_input, sink) => {
            createTextMessage(sink, "Scheduled trigger processed.");
            return { type: "stop" as const };
          },
        },
        input: {},
      },
    );

    expect(orchestration.success).toBe(true);
    expect(TaskManager.getRun(run.runId)?.status).toBe("done");
  });

  it("event trigger flow: watcher -> router -> dispatcher -> task run execution", async () => {
    const task = createTask({
      triggers: [
        {
          id: "event-1",
          type: "event",
          name: "fs.changed",
        },
      ],
    });

    Router.register({
      id: "rule-fs-changed",
      match: { name: "fs.changed" },
      action: "trigger_task",
      target: { taskId: task.id },
    });

    const dispatchPromises: Promise<void>[] = [];
    const dispatchedRunIds: string[] = [];

    const watcher = new FilesystemWatcher(
      {
        debounceMs: 10,
        recursive: false,
        includePatterns: ["src/"],
        excludePatterns: [],
      },
      (fileEvent) => {
        const payload = {
          path: fileEvent.path,
          event: fileEvent.event,
          at: fileEvent.timestamp,
        };
        const envelope = Envelope.create("fs.changed", "watcher", payload);

        const decision = Router.route(envelope);
        for (const routedTaskId of decision.targets) {
          dispatchPromises.push(
            Dispatcher.dispatch(routedTaskId, {
              triggerId: "event-1",
              type: "event",
              occurredAt: fileEvent.timestamp,
              payload,
              context: { traceId: envelope.traceId },
            }).then((result) => {
              if ("runId" in result) {
                dispatchedRunIds.push(result.runId);
              }
            }),
          );
        }
      },
    );

    (
      watcher as unknown as {
        handleEvent(path: string, eventType: "change"): void;
      }
    ).handleEvent("/tmp/src/file.ts", "change");

    await sleep(40);
    await Promise.all(dispatchPromises);

    expect(dispatchedRunIds).toHaveLength(1);

    const runId = dispatchedRunIds[0]!;
    const orchestration = await RunWorker.run(
      {
        taskId: task.id,
        runId,
        maxRetries: 0,
      },
      {
        llm: {
          run: async (_input, sink) => {
            createTextMessage(sink, "Event-triggered run completed.");
            return { type: "stop" as const };
          },
        },
        input: {},
      },
    );

    expect(orchestration.success).toBe(true);
    expect(TaskManager.getRun(runId)?.status).toBe("done");
    watcher.clearAll();
  });

  it("permission flow: ask policy blocks -> approve -> resume -> complete", async () => {
    const task = createTask({
      policy: { permission: "ask" },
      triggers: [{ id: "manual-ask", type: "manual" }],
    });

    const triggerResult = await TaskManager.trigger(task.id, {
      triggerId: "manual-ask",
      type: "manual",
      occurredAt: Date.now(),
      context: { userId: "reviewer-1" },
    });

    expect("runId" in triggerResult).toBe(true);
    if (!("runId" in triggerResult)) return;

    expect(TaskManager.getRun(triggerResult.runId)?.status).toBe("blocked");

    const blockedAttempt = await RunWorker.run(
      {
        taskId: task.id,
        runId: triggerResult.runId,
        maxRetries: 0,
      },
      {
        llm: {
          run: async () => ({ type: "stop" as const }),
        },
        input: {},
      },
    );

    expect(blockedAttempt.success).toBe(false);
    expect(blockedAttempt.error).toContain("waiting for approval");

    const resumed = TaskManager.resumeRun(triggerResult.runId, {
      approvedBy: "reviewer-1",
      approvalType: "once",
    });
    expect(resumed).toBe(true);
    expect(TaskManager.getRun(triggerResult.runId)?.status).toBe("scheduled");

    const resumedAttempt = await RunWorker.run(
      {
        taskId: task.id,
        runId: triggerResult.runId,
        maxRetries: 0,
      },
      {
        llm: {
          run: async (_input, sink) => {
            createTextMessage(sink, "Approved run completed.");
            return { type: "stop" as const };
          },
        },
        input: {},
      },
    );

    expect(resumedAttempt.success).toBe(true);
    expect(TaskManager.getRun(triggerResult.runId)?.status).toBe("done");
  });

  it("concurrent execution flow: queue mode serializes runs", async () => {
    const task = createTask({
      policy: {
        permission: "notify",
        concurrency: { maxRunning: 1, mode: "queue" },
      },
      triggers: [{ id: "manual-queue", type: "manual" }],
    });

    const first = await TaskManager.trigger(task.id, {
      triggerId: "manual-queue",
      type: "manual",
      occurredAt: Date.now(),
    });
    expect("runId" in first).toBe(true);
    if (!("runId" in first)) return;

    TaskManager.setRunStatus(first.runId, "running");

    const second = await TaskManager.trigger(task.id, {
      triggerId: "manual-queue",
      type: "manual",
      occurredAt: Date.now() + 1,
    });
    expect("runId" in second).toBe(true);
    if (!("runId" in second)) return;

    const third = await TaskManager.trigger(task.id, {
      triggerId: "manual-queue",
      type: "manual",
      occurredAt: Date.now() + 2,
    });
    expect(third).toEqual({ error: "concurrency_blocked" });

    const executionOrder: string[] = [];
    const llm = {
      run: async (input: Record<string, unknown>, sink: Sink) => {
        executionOrder.push(String(input.runId));
        createTextMessage(sink, `Completed ${String(input.runId)}`);
        return { type: "stop" as const };
      },
    };

    const firstRun = await RunWorker.run(
      {
        taskId: task.id,
        runId: first.runId,
        maxRetries: 0,
      },
      { llm, input: {} },
    );
    expect(firstRun.success).toBe(true);

    const secondRun = await RunWorker.run(
      {
        taskId: task.id,
        runId: second.runId,
        maxRetries: 0,
      },
      { llm, input: {} },
    );
    expect(secondRun.success).toBe(true);

    expect(executionOrder).toEqual([first.runId, second.runId]);
    expect(TaskManager.getRun(first.runId)?.status).toBe("done");
    expect(TaskManager.getRun(second.runId)?.status).toBe("done");
  });
});
