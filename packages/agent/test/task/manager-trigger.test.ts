import { describe, expect, test, beforeEach } from "bun:test";
import { TaskManager, TriggerResult } from "../../src/task/manager";
import { TaskStorage, InMemoryTaskStore } from "../../src/task/storage";
import type { Task, TriggerSignal } from "../../src/task/types";

describe("TaskManager.trigger", () => {
  beforeEach(() => {
    TaskStorage.reset();
  });

  function createTask(overrides: Partial<Task.CreateInput> = {}): Task.Info {
    return TaskManager.create({
      title: "Test Task",
      owner: { type: "user", id: "user-1" },
      triggers: [{ id: "manual-1", type: "manual" }],
      ...overrides,
    });
  }

  function createSignal(overrides: Partial<TriggerSignal> = {}): TriggerSignal {
    return {
      triggerId: "manual-1",
      type: "manual",
      occurredAt: Date.now(),
      ...overrides,
    };
  }

  describe("basic trigger", () => {
    test("returns not_found for non-existent task", async () => {
      const result = await TaskManager.trigger("non-existent", createSignal());
      expect(result).toEqual({ error: "not_found" });
    });

    test("creates TaskRun with scheduled status for notify permission", async () => {
      const task = createTask({ policy: { permission: "notify" } });
      const result = await TaskManager.trigger(task.id, createSignal());

      expect("runId" in result).toBe(true);
      if ("runId" in result) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result.runId);
        expect(run).toBeDefined();
        expect(run?.status).toBe("scheduled");
      }
    });

    test("creates TaskRun with blocked status for ask permission", async () => {
      const task = createTask({ policy: { permission: "ask" } });
      const result = await TaskManager.trigger(task.id, createSignal());

      expect("runId" in result).toBe(true);
      if ("runId" in result) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result.runId);
        expect(run).toBeDefined();
        expect(run?.status).toBe("blocked");
      }
    });

    test("returns denied for deny permission", async () => {
      const task = createTask({ policy: { permission: "deny" } });
      const result = await TaskManager.trigger(task.id, createSignal());
      expect(result).toEqual({ error: "denied" });
    });

    test("default permission is notify", async () => {
      const task = createTask({ policy: {} });
      const result = await TaskManager.trigger(task.id, createSignal());

      expect("runId" in result).toBe(true);
      if ("runId" in result) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result.runId);
        expect(run?.status).toBe("scheduled");
      }
    });
  });

  describe("rate limiting", () => {
    test("allows triggers within rate limit", async () => {
      const task = createTask({
        policy: { rateLimit: { maxPerWindow: 2, windowMs: 60000 } },
      });

      const result1 = await TaskManager.trigger(task.id, createSignal());
      const result2 = await TaskManager.trigger(
        task.id,
        createSignal({ occurredAt: Date.now() + 1 }),
      );

      expect("runId" in result1).toBe(true);
      expect("runId" in result2).toBe(true);
    });

    test("blocks triggers exceeding rate limit", async () => {
      const task = createTask({
        policy: { rateLimit: { maxPerWindow: 1, windowMs: 60000 } },
      });

      const result1 = await TaskManager.trigger(task.id, createSignal());
      const result2 = await TaskManager.trigger(
        task.id,
        createSignal({ occurredAt: Date.now() + 1 }),
      );

      expect("runId" in result1).toBe(true);
      expect(result2).toEqual({ error: "rate_limited" });
    });
  });

  describe("deduplication", () => {
    test("dedupes identical triggers within window", async () => {
      const task = createTask({
        policy: { dedupe: { windowMs: 60000 } },
      });
      const signal = createSignal();

      const result1 = await TaskManager.trigger(task.id, signal);
      const result2 = await TaskManager.trigger(task.id, signal);

      expect("runId" in result1).toBe(true);
      expect(result2).toEqual({ error: "deduped" });
    });

    test("allows different triggers", async () => {
      const task = createTask({
        policy: { dedupe: { windowMs: 60000 } },
      });

      const result1 = await TaskManager.trigger(
        task.id,
        createSignal({ occurredAt: 1000 }),
      );
      const result2 = await TaskManager.trigger(
        task.id,
        createSignal({ occurredAt: 2000 }),
      );

      expect("runId" in result1).toBe(true);
      expect("runId" in result2).toBe(true);
    });
  });

  describe("concurrency", () => {
    test("blocks when max running reached with drop mode", async () => {
      const task = createTask({
        policy: { concurrency: { maxRunning: 1, mode: "drop" } },
      });

      const result1 = await TaskManager.trigger(task.id, createSignal());
      expect("runId" in result1).toBe(true);

      if ("runId" in result1) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result1.runId);
        if (run) {
          store.run.set(task.id, { ...run, status: "running" });
        }
      }

      const result2 = await TaskManager.trigger(
        task.id,
        createSignal({ occurredAt: Date.now() + 1 }),
      );
      expect(result2).toEqual({ error: "concurrency_blocked" });
    });

    test("allows queue when max running reached with queue mode", async () => {
      const task = createTask({
        policy: { concurrency: { maxRunning: 1, mode: "queue" } },
      });

      const result1 = await TaskManager.trigger(task.id, createSignal());
      expect("runId" in result1).toBe(true);

      if ("runId" in result1) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result1.runId);
        if (run) {
          store.run.set(task.id, { ...run, status: "running" });
        }
      }

      const result2 = await TaskManager.trigger(
        task.id,
        createSignal({ occurredAt: Date.now() + 1 }),
      );
      expect("runId" in result2).toBe(true);
    });

    test("blocks second queue entry with queue mode", async () => {
      const task = createTask({
        policy: { concurrency: { maxRunning: 1, mode: "queue" } },
      });

      const result1 = await TaskManager.trigger(task.id, createSignal());
      expect("runId" in result1).toBe(true);

      if ("runId" in result1) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result1.runId);
        if (run) {
          store.run.set(task.id, { ...run, status: "running" });
        }
      }

      const result2 = await TaskManager.trigger(
        task.id,
        createSignal({ occurredAt: Date.now() + 1 }),
      );
      expect("runId" in result2).toBe(true);

      const result3 = await TaskManager.trigger(
        task.id,
        createSignal({ occurredAt: Date.now() + 2 }),
      );
      expect(result3).toEqual({ error: "concurrency_blocked" });
    });
  });

  describe("idempotency key generation", () => {
    test("generates correct key for cron trigger", async () => {
      const task = createTask();
      const occurredAt = new Date("2024-01-15T09:00:00Z").getTime();
      const signal = createSignal({
        triggerId: "cron-daily",
        type: "cron",
        occurredAt,
      });

      const result = await TaskManager.trigger(task.id, signal);
      expect("runId" in result).toBe(true);

      if ("runId" in result) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result.runId);
        expect(run?.idempotencyKey).toContain(task.id);
        expect(run?.idempotencyKey).toContain("cron-daily");
        expect(run?.idempotencyKey).toContain("2024-01-15T09:00:00.000Z");
      }
    });

    test("generates correct key for interval trigger", async () => {
      const task = createTask();
      const occurredAt = 12345000;
      const signal = createSignal({
        triggerId: "interval-5m",
        type: "interval",
        occurredAt,
      });

      const result = await TaskManager.trigger(task.id, signal);
      expect("runId" in result).toBe(true);

      if ("runId" in result) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result.runId);
        expect(run?.idempotencyKey).toContain(task.id);
        expect(run?.idempotencyKey).toContain("interval-5m");
        expect(run?.idempotencyKey).toContain("tick-12345");
      }
    });

    test("generates correct key for manual trigger", async () => {
      const task = createTask();
      const occurredAt = 1705312845678;
      const signal = createSignal({
        triggerId: "manual-1",
        type: "manual",
        occurredAt,
      });

      const result = await TaskManager.trigger(task.id, signal);
      expect("runId" in result).toBe(true);

      if ("runId" in result) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result.runId);
        expect(run?.idempotencyKey).toBe(`${task.id}:manual:${occurredAt}`);
      }
    });

    test("generates correct key for event trigger with payload", async () => {
      const task = createTask();
      const signal = createSignal({
        triggerId: "github-issue",
        type: "event",
        payload: { issue: { id: 123, action: "opened" } },
        occurredAt: Date.now(),
      });

      const result = await TaskManager.trigger(task.id, signal);
      expect("runId" in result).toBe(true);

      if ("runId" in result) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result.runId);
        expect(run?.idempotencyKey).toContain(task.id);
        expect(run?.idempotencyKey).toContain("github-issue");
      }
    });
  });

  describe("TaskRun creation", () => {
    test("creates TaskRun with correct fields", async () => {
      const task = createTask({ assignedAgentId: "agent-1" });
      const signal = createSignal({
        payload: { key: "value" },
        context: { userId: "user-1", traceId: "trace-1" },
      });

      const result = await TaskManager.trigger(task.id, signal);
      expect("runId" in result).toBe(true);

      if ("runId" in result) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result.runId);

        expect(run?.taskId).toBe(task.id);
        expect(run?.sessionKey).toBe(`task:${task.id}:run:${result.runId}`);
        expect(run?.trigger.id).toBe(signal.triggerId);
        expect(run?.trigger.type).toBe(signal.type);
        expect(run?.payload).toEqual(signal.payload);
        expect(run?.context).toEqual(signal.context);
        expect(run?.attempt).toBe(1);
        expect(run?.agentId).toBe("agent-1");
        expect(run?.scheduledAt).toBeDefined();
      }
    });

    test("updates task with pendingRun and status", async () => {
      const task = createTask();
      const result = await TaskManager.trigger(task.id, createSignal());

      expect("runId" in result).toBe(true);

      const store = TaskStorage.getAdapter();
      const updatedTask = store.task.get(task.id);

      expect(updatedTask?.status).toBe("scheduled");
      expect(updatedTask?.pendingRun).toBeDefined();
      if ("runId" in result) {
        expect(updatedTask?.pendingRun?.runId).toBe(result.runId);
      }
    });
  });

  describe("gate pipeline order", () => {
    test("rate limit is checked before dedupe", async () => {
      const task = createTask({
        policy: {
          rateLimit: { maxPerWindow: 1, windowMs: 60000 },
          dedupe: { windowMs: 60000 },
        },
      });

      const signal = createSignal();
      await TaskManager.trigger(task.id, signal);
      const result = await TaskManager.trigger(task.id, signal);

      expect(result).toEqual({ error: "rate_limited" });
    });

    test("dedupe is checked before concurrency", async () => {
      const task = createTask({
        policy: {
          dedupe: { windowMs: 60000 },
          concurrency: { maxRunning: 1, mode: "drop" },
        },
      });

      const signal = createSignal();
      const result1 = await TaskManager.trigger(task.id, signal);
      expect("runId" in result1).toBe(true);

      if ("runId" in result1) {
        const store = TaskStorage.getAdapter();
        const run = store.run.get(result1.runId);
        if (run) {
          store.run.set(task.id, { ...run, status: "running" });
        }
      }

      const result2 = await TaskManager.trigger(task.id, signal);
      expect(result2).toEqual({ error: "deduped" });
    });
  });
});
