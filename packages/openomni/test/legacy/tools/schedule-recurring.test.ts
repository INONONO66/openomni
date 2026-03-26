import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ScheduleTool } from "../../../src/legacy/tools/schedule";
import { TaskManager } from "../../../src/legacy/task/manager";
import { Scheduler } from "../../../src/legacy/trigger/scheduler";
import { TaskStorage } from "../../../src/legacy/task/storage";

describe("ScheduleTool - Recurring Schedules", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Scheduler.clear();
  });

  afterEach(() => {
    Scheduler.clear();
  });

  describe("cron recurring", () => {
    it("should create TriggerCron when recurring.type === 'cron'", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Cron task",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "cron",
          expression: "0 10 * * *",
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);
      expect(output.success).toBe(true);
      expect(output.taskId).toBeDefined();
      expect(output.recurring).toBeDefined();
      expect(output.recurring.type).toBe("cron");
      expect(output.recurring.expression).toBe("0 10 * * *");
    });

    it("should register TriggerCron with Scheduler", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Cron registration test",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "cron",
          expression: "0 0 * * *",
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      const taskId = output.taskId;

      const registeredTriggers = Scheduler.getRegisteredTriggers(taskId);
      expect(registeredTriggers.length).toBeGreaterThan(0);
      expect(registeredTriggers[0]).toBeDefined();
    });

    it("should reject cron without expression field", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Cron without expression",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "cron",
          // Missing expression field
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.error).toBe("invalid_cron_config");
      expect(output.message).toContain("expression");
    });
  });

  describe("interval recurring", () => {
    it("should create TriggerInterval when recurring.type === 'interval'", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Interval task",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "interval",
          intervalMs: 3600000,
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);
      expect(output.success).toBe(true);
      expect(output.taskId).toBeDefined();
      expect(output.recurring).toBeDefined();
      expect(output.recurring.type).toBe("interval");
      expect(output.recurring.intervalMs).toBe(3600000);
    });

    it("should register TriggerInterval with Scheduler", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Interval registration test",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "interval",
          intervalMs: 1800000,
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      const taskId = output.taskId;

      const registeredTriggers = Scheduler.getRegisteredTriggers(taskId);
      expect(registeredTriggers.length).toBeGreaterThan(0);
      expect(registeredTriggers[0]).toBeDefined();
    });

    it("should reject interval without intervalMs field", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Interval without intervalMs",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "interval",
          // Missing intervalMs field
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.error).toBe("invalid_interval_config");
      expect(output.message).toContain("intervalMs");
    });
  });

  describe("once recurring (default)", () => {
    it("should create TriggerOnce when recurring.type === 'once'", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Once task",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "once",
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);
      expect(output.success).toBe(true);
      expect(output.taskId).toBeDefined();
      // recurring info should not be included for 'once' type
      expect(output.recurring).toBeUndefined();
    });

    it("should create TriggerOnce when no recurring field provided", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "No recurring field",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        // No recurring field
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);
      expect(output.success).toBe(true);
      expect(output.taskId).toBeDefined();
      expect(output.recurring).toBeUndefined();
    });

    it("should register TriggerOnce with Scheduler for default behavior", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Default once trigger",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      const taskId = output.taskId;

      const registeredTriggers = Scheduler.getRegisteredTriggers(taskId);
      expect(registeredTriggers.length).toBeGreaterThan(0);
      expect(registeredTriggers[0]).toBeDefined();
    });
  });

  describe("Scheduler.isRegistered() verification", () => {
    it("should verify cron trigger is registered with Scheduler", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Cron isRegistered test",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "cron",
          expression: "0 12 * * *",
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      const taskId = output.taskId;

      const triggers = Scheduler.getRegisteredTriggers(taskId);
      expect(triggers.length).toBeGreaterThan(0);
      expect(triggers[0]).toBeDefined();
    });

    it("should verify interval trigger is registered with Scheduler", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Interval isRegistered test",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "interval",
          intervalMs: 7200000,
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      const taskId = output.taskId;

      const triggers = Scheduler.getRegisteredTriggers(taskId);
      expect(triggers.length).toBeGreaterThan(0);
      expect(triggers[0]).toBeDefined();
    });
  });

  describe("output format with recurring info", () => {
    it("should include recurring info in success output for cron", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Output format cron",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "cron",
          expression: "0 9 * * 1-5",
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      expect(output.success).toBe(true);
      expect(output.recurring).toBeDefined();
      expect(output.recurring.type).toBe("cron");
      expect(output.recurring.expression).toBe("0 9 * * 1-5");
      expect(output.taskId).toBeDefined();
      expect(output.plannedStartAt).toBeDefined();
      expect(output.dueAt).toBeDefined();
    });

    it("should include recurring info in success output for interval", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Output format interval",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "interval",
          intervalMs: 5400000,
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      expect(output.success).toBe(true);
      expect(output.recurring).toBeDefined();
      expect(output.recurring.type).toBe("interval");
      expect(output.recurring.intervalMs).toBe(5400000);
      expect(output.taskId).toBeDefined();
      expect(output.plannedStartAt).toBeDefined();
      expect(output.dueAt).toBeDefined();
    });

    it("should not include recurring info for once type", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Output format once",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
        recurring: {
          type: "once",
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      expect(output.success).toBe(true);
      expect(output.recurring).toBeUndefined();
      expect(output.taskId).toBeDefined();
      expect(output.plannedStartAt).toBeDefined();
      expect(output.dueAt).toBeDefined();
    });
  });

  describe("edge cases and error handling", () => {
    it("should handle multiple cron expressions", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const expressions = ["0 0 * * *", "*/15 * * * *", "0 0 1 * *", "0 0 * * 0"];

      for (const expr of expressions) {
        const input = {
          description: `Cron ${expr}`,
          dueAt: new Date(dueAtMs).toISOString(),
          estimatedRuntimeMs: 10 * 60 * 1000,
          recurring: {
            type: "cron",
            expression: expr,
          },
        };

        const result = ScheduleTool.execute(input, {
          userId: "user123",
        });

        expect(result.isError).toBe(false);
        const output = JSON.parse(result.output);
        expect(output.recurring.expression).toBe(expr);
      }
    });

    it("should handle various interval values", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const intervals = [60000, 300000, 3600000, 86400000];

      for (const intervalMs of intervals) {
        const input = {
          description: `Interval ${intervalMs}`,
          dueAt: new Date(dueAtMs).toISOString(),
          estimatedRuntimeMs: 10 * 60 * 1000,
          recurring: {
            type: "interval",
            intervalMs,
          },
        };

        const result = ScheduleTool.execute(input, {
          userId: "user123",
        });

        expect(result.isError).toBe(false);
        const output = JSON.parse(result.output);
        expect(output.recurring.intervalMs).toBe(intervalMs);
      }
    });

    it("should preserve plannedStartAt calculation with recurring", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;
      const estimatedRuntimeMs = 20 * 60 * 1000;
      const safetyBufferMs = 2 * 60 * 1000;

      const input = {
        description: "Calculation with recurring",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs,
        recurring: {
          type: "cron",
          expression: "0 10 * * *",
        },
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      const plannedStartAtMs = new Date(output.plannedStartAt).getTime();
      const expectedPlannedStartAtMs = dueAtMs - estimatedRuntimeMs - safetyBufferMs;

      expect(plannedStartAtMs).toBe(expectedPlannedStartAtMs);
    });
  });
});
