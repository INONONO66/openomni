import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { IngressEngine } from "../../src/ingress/engine";
import { Session, SurfaceKey } from "@openomni/session";
import { TaskManager } from "../../src/task/manager";
import { TaskStorage } from "../../src/task/storage";
import type {
  InboundEvent,
  RunResult,
  DeliveryAdapter,
  RunPlanner,
} from "../../src/ingress/interfaces";
import { randomUUID } from "crypto";

const originalIngest = IngressEngine.ingest;

function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    id: overrides.id ?? randomUUID(),
    surface: overrides.surface ?? "tui",
    name: overrides.name ?? "message",
    payload: overrides.payload ?? "Hello, world!",
    dedupeKey: overrides.dedupeKey,
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    channel: overrides.channel,
    workspace: overrides.workspace,
    userId: overrides.userId,
    meta: overrides.meta,
  };
}

describe("IngressEngine", () => {
  beforeEach(() => {
    IngressEngine.ingest = originalIngest;
    if ((IngressEngine.ingest as unknown as { mock?: unknown }).mock) {
      (
        IngressEngine.ingest as unknown as { mockRestore: () => void }
      ).mockRestore();
    }
    IngressEngine.reset();
    IngressEngine.configure({});
    Session.storage.clear();
    SurfaceKey.clear();
    TaskStorage.reset();
  });

  afterEach(() => {
    IngressEngine.reset();
    IngressEngine.configure({});
    Session.storage.clear();
    SurfaceKey.clear();
    const store = TaskStorage.getAdapter();
    store.task.list().forEach((t) => store.task.remove(t.id));
  });

  describe("validation", () => {
    it("rejects event with missing id", async () => {
      const event = makeEvent({ id: "" });
      try {
        await IngressEngine.ingest(event);
        throw new Error("Expected ingest to throw");
      } catch (error) {
        expect(String(error)).toContain("non-empty string id");
      }
    });

    it("rejects event with missing surface", async () => {
      const event = makeEvent({ surface: "" });
      try {
        await IngressEngine.ingest(event);
        throw new Error("Expected ingest to throw");
      } catch (error) {
        expect(String(error)).toContain("non-empty string surface");
      }
    });

    it("rejects event with missing name", async () => {
      const event = makeEvent({ name: "" });
      try {
        await IngressEngine.ingest(event);
        throw new Error("Expected ingest to throw");
      } catch (error) {
        expect(String(error)).toContain("non-empty string name");
      }
    });
  });

  describe("full pipeline", () => {
    it("ingests event and creates session", async () => {
      const event = makeEvent({ surface: "tui", channel: "local" });
      const results = await IngressEngine.ingest(event);

      expect(results.length).toBe(1);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.sessionId).toBeDefined();
    });

    it("resolves session via surfaceKey", async () => {
      const event1 = makeEvent({
        surface: "slack",
        workspace: "W1",
        channel: "C1",
      });
      const event2 = makeEvent({
        surface: "slack",
        workspace: "W1",
        channel: "C1",
      });

      const results1 = await IngressEngine.ingest(event1);
      const results2 = await IngressEngine.ingest(event2);

      expect(results1[0]!.sessionId).toBe(results2[0]!.sessionId);
    });

    it("creates run_agent RunRequest for interactive events by default", async () => {
      const event = makeEvent();
      const results = await IngressEngine.ingest(event);

      expect(results.length).toBe(1);
      expect(results[0]!.request.kind).toBe("run_agent");
    });

    it("creates trigger_task RunRequest for scheduler events with taskId", async () => {
      const task = TaskManager.create({
        title: "Test task",
        owner: { type: "user", id: "u1" },
        triggers: [{ id: "t1", type: "manual" }],
      });

      const event = makeEvent({
        surface: "scheduler",
        name: "scheduler.cron",
        meta: {
          taskId: task.id,
          triggerId: "t1",
          triggerType: "manual",
        },
      });

      const results = await IngressEngine.ingest(event);

      expect(results.length).toBe(1);
      expect(results[0]!.request.kind).toBe("trigger_task");
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.runId).toBeDefined();
    });
  });

  describe("dedup", () => {
    it("deduplicates events with same dedupeKey", async () => {
      const dedupeKey = "unique-key-123";
      const event1 = makeEvent({ dedupeKey });
      const event2 = makeEvent({ dedupeKey });

      const results1 = await IngressEngine.ingest(event1);
      const results2 = await IngressEngine.ingest(event2);

      expect(results1[0]!.sessionId).toBeDefined();
      expect(results2[0]!.sessionId).toBe(results1[0]!.sessionId);
    });

    it("allows events without dedupeKey through", async () => {
      const event1 = makeEvent();
      const event2 = makeEvent();

      const results1 = await IngressEngine.ingest(event1);
      const results2 = await IngressEngine.ingest(event2);

      expect(results1.length).toBe(1);
      expect(results2.length).toBe(1);
    });

    it("allows events with different dedupeKeys", async () => {
      const event1 = makeEvent({ dedupeKey: "key-a" });
      const event2 = makeEvent({ dedupeKey: "key-b" });

      const results1 = await IngressEngine.ingest(event1);
      const results2 = await IngressEngine.ingest(event2);

      expect(results1[0]!.sessionId).toBeDefined();
      expect(results2[0]!.sessionId).toBeDefined();
    });
  });

  describe("custom planner", () => {
    it("uses configured RunPlanner", async () => {
      const customPlanner: RunPlanner = {
        plan(_envelope, session) {
          return [
            {
              kind: "notify_only",
              session,
              envelope: _envelope,
              notificationRequest: {
                type: "test",
                severity: "info",
                title: "Test Notification",
                body: "This is a test",
              },
            },
          ];
        },
      };

      IngressEngine.configure({ planner: customPlanner });
      const event = makeEvent();
      const results = await IngressEngine.ingest(event);

      expect(results.length).toBe(1);
      expect(results[0]!.request.kind).toBe("notify_only");
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.summary).toContain("Notification delivered");
    });

    it("handles empty plan result", async () => {
      const emptyPlanner: RunPlanner = {
        plan() {
          return [];
        },
      };

      IngressEngine.configure({ planner: emptyPlanner });
      const event = makeEvent();
      const results = await IngressEngine.ingest(event);

      expect(results.length).toBe(0);
    });
  });

  describe("delivery", () => {
    it("calls DeliveryAdapter for each result", async () => {
      const delivered: RunResult[] = [];
      const adapter: DeliveryAdapter = {
        name: "test",
        async deliver(result) {
          delivered.push(result);
        },
      };

      IngressEngine.configure({ delivery: adapter });
      const event = makeEvent();
      await IngressEngine.ingest(event);

      expect(delivered.length).toBe(1);
      expect(delivered[0]!.success).toBe(true);
    });
  });

  describe("trigger_task execution", () => {
    it("returns error for missing task", async () => {
      const event = makeEvent({
        surface: "scheduler",
        name: "scheduler.cron",
        meta: {
          taskId: "nonexistent-task-id",
          triggerId: "t1",
          triggerType: "manual",
        },
      });

      const results = await IngressEngine.ingest(event);

      expect(results.length).toBe(1);
      expect(results[0]!.success).toBe(false);
      expect(results[0]!.error).toContain("not_found");
    });
  });

  describe("configure", () => {
    it("accepts custom dedup window", async () => {
      IngressEngine.configure({ dedupeWindowMs: 1 });

      const dedupeKey = "short-window";
      const event1 = makeEvent({ dedupeKey });
      const results1 = await IngressEngine.ingest(event1);
      expect(results1.length).toBe(1);

      await new Promise((r) => setTimeout(r, 5));

      const event2 = makeEvent({ dedupeKey });
      const results2 = await IngressEngine.ingest(event2);
      expect(results2[0]!.sessionId).toBeDefined();
    });
  });
});
