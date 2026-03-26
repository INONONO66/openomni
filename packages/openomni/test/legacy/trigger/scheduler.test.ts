import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Scheduler, CronParser } from "../../../src/legacy/trigger/scheduler";
import { TaskManager } from "../../../src/legacy/task/manager";
import { TaskStorage } from "../../../src/legacy/task/storage";
import type { Task } from "../../../src/legacy/task/types";

describe("CronParser", () => {
  describe("parse", () => {
    test("parses wildcard expression", () => {
      const fields = CronParser.parse("* * * * *");
      expect(fields).not.toBeNull();
      expect(fields!.minute).toHaveLength(60);
      expect(fields!.hour).toHaveLength(24);
      expect(fields!.dayOfMonth).toHaveLength(31);
      expect(fields!.month).toHaveLength(12);
      expect(fields!.dayOfWeek).toHaveLength(7);
    });

    test("parses specific values", () => {
      const fields = CronParser.parse("30 9 15 6 3");
      expect(fields).not.toBeNull();
      expect(fields!.minute).toEqual([30]);
      expect(fields!.hour).toEqual([9]);
      expect(fields!.dayOfMonth).toEqual([15]);
      expect(fields!.month).toEqual([6]);
      expect(fields!.dayOfWeek).toEqual([3]);
    });

    test("parses step values", () => {
      const fields = CronParser.parse("*/15 */6 * * *");
      expect(fields).not.toBeNull();
      expect(fields!.minute).toEqual([0, 15, 30, 45]);
      expect(fields!.hour).toEqual([0, 6, 12, 18]);
    });

    test("parses ranges", () => {
      const fields = CronParser.parse("0-5 9-17 * * *");
      expect(fields).not.toBeNull();
      expect(fields!.minute).toEqual([0, 1, 2, 3, 4, 5]);
      expect(fields!.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    });

    test("parses lists", () => {
      const fields = CronParser.parse("0,30 9,12,18 * * *");
      expect(fields).not.toBeNull();
      expect(fields!.minute).toEqual([0, 30]);
      expect(fields!.hour).toEqual([9, 12, 18]);
    });

    test("parses complex expression", () => {
      const fields = CronParser.parse("0,30 9-17 1-15 1,6 1-5");
      expect(fields).not.toBeNull();
      expect(fields!.minute).toEqual([0, 30]);
      expect(fields!.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
      expect(fields!.dayOfMonth).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(fields!.month).toEqual([1, 6]);
      expect(fields!.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    });

    test("returns null for invalid expression", () => {
      expect(CronParser.parse("invalid")).toBeNull();
      expect(CronParser.parse("* * *")).toBeNull();
      expect(CronParser.parse("* * * * * *")).toBeNull();
    });
  });

  describe("getNextFireTime", () => {
    test("finds next minute for wildcard", () => {
      const fields = CronParser.parse("* * * * *")!;
      const after = new Date("2024-01-15T09:30:00Z");
      const next = CronParser.getNextFireTime(fields, after);
      expect(next.getTime()).toBe(new Date("2024-01-15T09:31:00Z").getTime());
    });

    test("finds next matching minute", () => {
      const fields = CronParser.parse("0 * * * *")!;
      const after = new Date("2024-01-15T09:30:00Z");
      const next = CronParser.getNextFireTime(fields, after);
      expect(next.getTime()).toBe(new Date("2024-01-15T10:00:00Z").getTime());
    });

    test("finds next matching hour", () => {
      const fields = CronParser.parse("0 12 * * *")!;
      const after = new Date("2024-01-15T09:00:00Z");
      const next = CronParser.getNextFireTime(fields, after);
      expect(next.getTime()).toBe(new Date("2024-01-15T12:00:00Z").getTime());
    });

    test("rolls to next day when hour passed", () => {
      const fields = CronParser.parse("0 9 * * *")!;
      const after = new Date("2024-01-15T12:00:00Z");
      const next = CronParser.getNextFireTime(fields, after);
      expect(next.getTime()).toBe(new Date("2024-01-16T09:00:00Z").getTime());
    });
  });
});

describe("Scheduler", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Scheduler.clear();
  });

  afterEach(() => {
    Scheduler.clear();
  });

  function createTask(overrides: Partial<Task.CreateInput> = {}): Task.Info {
    return TaskManager.create({
      title: "Test Task",
      owner: { type: "user", id: "user-1" },
      triggers: [],
      ...overrides,
    });
  }

  describe("registerTrigger", () => {
    test("registers interval trigger", () => {
      const task = createTask();
      const trigger: Task.TriggerInterval = {
        id: "interval-1",
        type: "interval",
        ms: 60000,
      };

      const result = Scheduler.registerTrigger(task.id, trigger);

      expect(result).toBe(true);
      expect(Scheduler.isRegistered(task.id, trigger.id)).toBe(true);
    });

    test("registers once trigger", () => {
      const task = createTask();
      const trigger: Task.TriggerOnce = {
        id: "once-1",
        type: "once",
        at: Date.now() + 60000,
      };

      const result = Scheduler.registerTrigger(task.id, trigger);

      expect(result).toBe(true);
      expect(Scheduler.isRegistered(task.id, trigger.id)).toBe(true);
    });

    test("registers cron trigger", () => {
      const task = createTask();
      const trigger: Task.TriggerCron = {
        id: "cron-1",
        type: "cron",
        expr: "0 9 * * *",
      };

      const result = Scheduler.registerTrigger(task.id, trigger);

      expect(result).toBe(true);
      expect(Scheduler.isRegistered(task.id, trigger.id)).toBe(true);
    });

    test("returns false for invalid cron expression", () => {
      const task = createTask();
      const trigger: Task.TriggerCron = {
        id: "cron-invalid",
        type: "cron",
        expr: "invalid",
      };

      const result = Scheduler.registerTrigger(task.id, trigger);

      expect(result).toBe(false);
      expect(Scheduler.isRegistered(task.id, trigger.id)).toBe(false);
    });

    test("prevents duplicate registration", () => {
      const task = createTask();
      const trigger: Task.TriggerInterval = {
        id: "interval-1",
        type: "interval",
        ms: 60000,
      };

      Scheduler.registerTrigger(task.id, trigger);
      const result = Scheduler.registerTrigger(task.id, trigger);

      expect(result).toBe(false);
      expect(Scheduler.size()).toBe(1);
    });
  });

  describe("register", () => {
    test("registers all time-based triggers from task", () => {
      const task = createTask({
        triggers: [
          { id: "interval-1", type: "interval", ms: 60000 },
          { id: "cron-1", type: "cron", expr: "0 9 * * *" },
          { id: "manual-1", type: "manual" },
          { id: "event-1", type: "event", name: "test-event" },
        ],
      });

      Scheduler.register(task);

      expect(Scheduler.isRegistered(task.id, "interval-1")).toBe(true);
      expect(Scheduler.isRegistered(task.id, "cron-1")).toBe(true);
      expect(Scheduler.isRegistered(task.id, "manual-1")).toBe(false);
      expect(Scheduler.isRegistered(task.id, "event-1")).toBe(false);
    });
  });

  describe("unregister", () => {
    test("unregisters all triggers for task", () => {
      const task = createTask({
        triggers: [
          { id: "interval-1", type: "interval", ms: 60000 },
          { id: "cron-1", type: "cron", expr: "0 9 * * *" },
        ],
      });

      Scheduler.register(task);
      expect(Scheduler.size()).toBe(2);

      Scheduler.unregister(task.id);

      expect(Scheduler.isRegistered(task.id, "interval-1")).toBe(false);
      expect(Scheduler.isRegistered(task.id, "cron-1")).toBe(false);
      expect(Scheduler.size()).toBe(0);
    });
  });

  describe("unregisterTrigger", () => {
    test("unregisters specific trigger", () => {
      const task = createTask({
        triggers: [
          { id: "interval-1", type: "interval", ms: 60000 },
          { id: "interval-2", type: "interval", ms: 30000 },
        ],
      });

      Scheduler.register(task);

      const result = Scheduler.unregisterTrigger(task.id, "interval-1");

      expect(result).toBe(true);
      expect(Scheduler.isRegistered(task.id, "interval-1")).toBe(false);
      expect(Scheduler.isRegistered(task.id, "interval-2")).toBe(true);
    });

    test("returns false for non-existent trigger", () => {
      const result = Scheduler.unregisterTrigger("non-existent", "trigger-1");
      expect(result).toBe(false);
    });
  });

  describe("getNextFireTime", () => {
    test("returns next fire time for registered trigger", () => {
      const task = createTask();
      const now = Date.now();
      const trigger: Task.TriggerInterval = {
        id: "interval-1",
        type: "interval",
        ms: 60000,
      };

      Scheduler.registerTrigger(task.id, trigger);

      const nextFire = Scheduler.getNextFireTime(task.id, trigger.id);
      expect(nextFire).toBeDefined();
      expect(nextFire!).toBeGreaterThanOrEqual(now);
    });

    test("returns undefined for non-existent trigger", () => {
      const nextFire = Scheduler.getNextFireTime("non-existent", "trigger-1");
      expect(nextFire).toBeUndefined();
    });
  });

  describe("getRegisteredTriggers", () => {
    test("returns all trigger ids for task", () => {
      const task = createTask({
        triggers: [
          { id: "interval-1", type: "interval", ms: 60000 },
          { id: "cron-1", type: "cron", expr: "0 9 * * *" },
        ],
      });

      Scheduler.register(task);

      const triggers = Scheduler.getRegisteredTriggers(task.id);
      expect(triggers).toContain("interval-1");
      expect(triggers).toContain("cron-1");
      expect(triggers).toHaveLength(2);
    });

    test("returns empty array for task with no triggers", () => {
      const triggers = Scheduler.getRegisteredTriggers("non-existent");
      expect(triggers).toEqual([]);
    });
  });

  describe("clear", () => {
    test("removes all registered triggers", () => {
      const task1 = createTask();
      const task2 = createTask();

      Scheduler.registerTrigger(task1.id, {
        id: "t1",
        type: "interval",
        ms: 1000,
      });
      Scheduler.registerTrigger(task2.id, {
        id: "t2",
        type: "interval",
        ms: 1000,
      });

      expect(Scheduler.size()).toBe(2);

      Scheduler.clear();

      expect(Scheduler.size()).toBe(0);
    });
  });

  describe("once trigger behavior", () => {
    test("fires immediately and does not register when time is past", async () => {
      const task = createTask({ policy: { permission: "notify" } });
      const trigger: Task.TriggerOnce = {
        id: "once-past",
        type: "once",
        at: Date.now() - 1000,
      };

      const result = Scheduler.registerTrigger(task.id, trigger);

      expect(result).toBe(true);
      expect(Scheduler.isRegistered(task.id, trigger.id)).toBe(false);
    });
  });
});
