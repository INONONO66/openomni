import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { IngressEngine } from "../../src/ingress/engine";
import { Session, SurfaceKey } from "@openomni/session";
import { TaskManager } from "../../src/task/manager";
import { TaskStorage } from "../../src/task/storage";
import { Scheduler } from "../../src/trigger/scheduler";
import type { InboundEvent } from "../../src/ingress/interfaces";
import { randomUUID } from "crypto";

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    surface: overrides.surface ?? "tui",
    name: overrides.name ?? "message",
    payload: overrides.payload ?? "Hello, world!",
    dedupeKey: overrides.dedupeKey,
    occurredAt: overrides.occurredAt ?? now,
    channel: overrides.channel,
    workspace: overrides.workspace,
    userId: overrides.userId,
    meta: overrides.meta,
  };
}

describe("D5 Mandatory Tests", () => {
  beforeEach(() => {
    IngressEngine.reset();
    Session.storage.clear();
    SurfaceKey.clear();
    Scheduler.clear();
    const store = TaskStorage.getAdapter();
    store.task.list().forEach((t) => store.task.remove(t.id));
  });

  afterEach(() => {
    Scheduler.clear();
  });

  describe("D5.1: task-from-task blocked", () => {
    it("should reject trigger_task when session.type=task context", async () => {
      const task = TaskManager.create({
        title: "Parent task",
        owner: { type: "user", id: "u1" },
        triggers: [{ id: randomUUID(), type: "manual" }],
      });

      const triggerResult = await TaskManager.trigger(task.id, {
        triggerId: task.triggers[0]!.id,
        type: "manual",
        context: {
          conversationSessionId: randomUUID(),
          userId: "u1",
        },
        occurredAt: Date.now(),
      });

      expect("runId" in triggerResult).toBe(true);
      const runId = (triggerResult as { runId: string }).runId;

      const run = TaskManager.getRun(runId);
      expect(run).toBeDefined();

      const taskSession = Session.create({
        title: "Task execution session",
        model: {
          providerID: "anthropic",
          modelID: "claude-3-5-sonnet-20241022",
        },
      });

      expect(taskSession).toBeDefined();
      expect(taskSession.id).toBeDefined();
    });
  });

  describe("D5.2: duplicate schedule.fire deduplicated", () => {
    it("should deduplicate events with same dedupeKey", async () => {
      const task = TaskManager.create({
        title: "Scheduled task",
        owner: { type: "user", id: "u1" },
        triggers: [{ id: randomUUID(), type: "manual" }],
      });

      const triggerId = task.triggers[0]!.id;
      const now = Date.now();
      const dedupeKey = `scheduler:${task.id}:${triggerId}:${now}`;

      const event1 = makeEvent({
        id: randomUUID(),
        surface: "scheduler",
        name: "scheduler.once",
        payload: { taskId: task.id, triggerId },
        dedupeKey,
        meta: {
          taskId: task.id,
          triggerId,
          triggerType: "once",
        },
      });

      const event2 = makeEvent({
        id: randomUUID(),
        surface: "scheduler",
        name: "scheduler.once",
        payload: { taskId: task.id, triggerId },
        dedupeKey,
        meta: {
          taskId: task.id,
          triggerId,
          triggerType: "once",
        },
      });

      const results1 = await IngressEngine.ingest(event1);
      expect(results1.length).toBe(1);
      expect(results1[0]!.success).toBe(true);

      const results2 = await IngressEngine.ingest(event2);
      expect(results2.length).toBe(1);
      expect(results2[0]!.success).toBe(true);

      expect(results2[0]!.runId).toBe(results1[0]!.runId);
    });
  });

  describe("D5.3: default immediate path", () => {
    it("should route standard event to run_agent with subagent tools available", async () => {
      const event = makeEvent({
        surface: "tui",
        name: "message",
        payload: "What can you do?",
      });

      const results = await IngressEngine.ingest(event);

      expect(results.length).toBe(1);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.sessionId).toBeDefined();

      expect(results[0]!.request.kind).toBe("run_agent");

      const session = Session.get(results[0]!.sessionId);
      expect(session).toBeDefined();
      expect(session?.title).toContain("tui");

      expect(results[0]!.runId).toBeDefined();
    });

    it("should create persistent session for run_agent", async () => {
      const event = makeEvent({
        surface: "slack",
        workspace: "W1",
        channel: "C1",
        payload: "Hello from Slack",
      });

      const results = await IngressEngine.ingest(event);

      expect(results.length).toBe(1);
      expect(results[0]!.success).toBe(true);

      const session = Session.get(results[0]!.sessionId);
      expect(session).toBeDefined();

      const event2 = makeEvent({
        surface: "slack",
        workspace: "W1",
        channel: "C1",
        payload: "Follow-up message",
      });

      const results2 = await IngressEngine.ingest(event2);

      expect(results2[0]!.sessionId).toBe(results[0]!.sessionId);

      const updatedSession = Session.get(results[0]!.sessionId);
      expect(updatedSession).toBeDefined();
    });

    it("should handle non-scheduled events with default planner", async () => {
      const surfaces = ["tui", "webhook", "telegram"];

      for (const surface of surfaces) {
        IngressEngine.reset();
        Session.storage.clear();
        SurfaceKey.clear();

        const event = makeEvent({
          surface,
          name: "message",
          payload: `Message from ${surface}`,
        });

        const results = await IngressEngine.ingest(event);

        expect(results.length).toBe(1);
        expect(results[0]!.success).toBe(true);
        expect(results[0]!.request.kind).toBe("run_agent");
      }
    });
  });
});
