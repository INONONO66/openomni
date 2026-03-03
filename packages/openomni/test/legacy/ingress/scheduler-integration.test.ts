import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Scheduler } from "../../../src/legacy/trigger/scheduler";
import { IngressEngine } from "../../../src/legacy/ingress/engine";
import { TaskManager } from "../../../src/legacy/task/manager";
import { TaskStorage } from "../../../src/legacy/task/storage";
import { Session, SurfaceKey } from "@openomni/session";
import type { Task } from "../../../src/legacy/task/types";
import type { RunResult, DeliveryAdapter } from "../../../src/legacy/ingress/interfaces";

describe("Scheduler → IngressEngine Integration", () => {
  beforeEach(() => {
    Scheduler.clear();
    IngressEngine.reset();
    Session.storage.clear();
    SurfaceKey.clear();
    const store = TaskStorage.getAdapter();
    store.task.list().forEach((t) => store.task.remove(t.id));
  });

  afterEach(() => {
    Scheduler.clear();
  });

  it("scheduler.fire routes through IngressEngine", async () => {
    const delivered: RunResult[] = [];
    const adapter: DeliveryAdapter = {
      name: "test",
      async deliver(result) {
        delivered.push(result);
      },
    };
    IngressEngine.configure({ delivery: adapter });

    const task = TaskManager.create({
      title: "Scheduled task",
      owner: { type: "user", id: "u1" },
      triggers: [{ id: "interval-1", type: "interval", ms: 50 }],
    });

    Scheduler.register(task);

    await new Promise((r) => setTimeout(r, 100));

    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(delivered[0]!.request.kind).toBe("trigger_task");
  });

  it("scheduler creates InboundEvent with correct surface type", async () => {
    const delivered: RunResult[] = [];
    const adapter: DeliveryAdapter = {
      name: "test",
      async deliver(result) {
        delivered.push(result);
      },
    };
    IngressEngine.configure({ delivery: adapter });

    const task = TaskManager.create({
      title: "Once task",
      owner: { type: "user", id: "u1" },
      triggers: [{ id: "once-1", type: "once", at: Date.now() - 1000 }],
    });

    Scheduler.registerTrigger(task.id, task.triggers[0] as Task.TriggerOnce);

    await new Promise((r) => setTimeout(r, 100));

    expect(delivered.length).toBeGreaterThanOrEqual(1);
    expect(delivered[0]!.request.envelope.source.type).toBe("scheduler");
  });

  it("scheduler dedup prevents duplicate task triggers", async () => {
    IngressEngine.configure({ dedupeWindowMs: 60_000 });

    const task = TaskManager.create({
      title: "Dedup task",
      owner: { type: "user", id: "u1" },
      triggers: [{ id: "t1", type: "manual" }],
    });

    const delivered: RunResult[] = [];
    const adapter: DeliveryAdapter = {
      name: "test",
      async deliver(result) {
        delivered.push(result);
      },
    };
    IngressEngine.configure({ delivery: adapter });

    const { ingest } = IngressEngine;

    const event1 = {
      id: "evt-1",
      surface: "scheduler",
      name: "scheduler.cron",
      payload: { taskId: task.id },
      dedupeKey: `scheduler:${task.id}:dedup-test`,
      occurredAt: new Date().toISOString(),
      meta: { taskId: task.id, triggerId: "t1", triggerType: "manual" },
    };

    const event2 = {
      ...event1,
      id: "evt-2",
    };

    const results1 = await IngressEngine.ingest(event1);
    const results2 = await IngressEngine.ingest(event2);

    expect(results1[0]!.sessionId).toBeDefined();
    expect(results2[0]!.sessionId).toBe(results1[0]!.sessionId);
  });

  it("scheduler interval trigger fires task through IngressEngine", async () => {
    const task = TaskManager.create({
      title: "Interval fire test",
      owner: { type: "user", id: "u1" },
      triggers: [{ id: "int-1", type: "interval", ms: 30 }],
    });

    Scheduler.register(task);

    await new Promise((r) => setTimeout(r, 80));

    const runs = TaskManager.listRuns(task.id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
  });
});
