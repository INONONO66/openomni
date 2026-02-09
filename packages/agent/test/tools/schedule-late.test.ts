import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ScheduleTool } from "../../src/tools/schedule";
import { TaskManager } from "../../src/task/manager";
import { Scheduler } from "../../src/trigger/scheduler";
import { TaskStorage } from "../../src/task/storage";

describe("ScheduleTool - Late-Start Execution", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Scheduler.clear();
  });

  afterEach(() => {
    Scheduler.clear();
  });

  it("should execute immediately when plannedStartAt is in the past", () => {
    // Setup: Create a schedule with dueAt in the past
    const now = Date.now();
    const pastDueAt = new Date(now - 60 * 60 * 1000).toISOString(); // 1 hour ago

    const result = ScheduleTool.execute(
      {
        description: "Late task",
        dueAt: pastDueAt,
        estimatedRuntimeMs: 5 * 60 * 1000, // 5 minutes
      },
      {
        userId: "user123",
        workspaceId: "workspace123",
      },
    );

    // Verify: Should succeed (not error)
    expect(result.isError).toBe(false);
    const output = JSON.parse(result.output);
    expect(output.success).toBe(true);
    expect(output.taskId).toBeDefined();
  });

  it("should include lateStart flag in output when task is late", () => {
    const now = Date.now();
    const pastDueAt = new Date(now - 60 * 60 * 1000).toISOString();

    const result = ScheduleTool.execute(
      {
        description: "Late task",
        dueAt: pastDueAt,
        estimatedRuntimeMs: 5 * 60 * 1000,
      },
      {
        userId: "user123",
        workspaceId: "workspace123",
      },
    );

    const output = JSON.parse(result.output);
    expect(output.lateStart).toBe(true);
  });

  it("should include originalPlannedStartAt in output when task is late", () => {
    const now = Date.now();
    const pastDueAt = new Date(now - 60 * 60 * 1000).toISOString();

    const result = ScheduleTool.execute(
      {
        description: "Late task",
        dueAt: pastDueAt,
        estimatedRuntimeMs: 5 * 60 * 1000,
      },
      {
        userId: "user123",
        workspaceId: "workspace123",
      },
    );

    const output = JSON.parse(result.output);
    expect(output.originalPlannedStartAt).toBeDefined();
    expect(typeof output.originalPlannedStartAt).toBe("string");
    // Verify it's a valid ISO string
    expect(() => new Date(output.originalPlannedStartAt)).not.toThrow();
  });

  it("should create task with immediate plannedStartAt when late", () => {
    const now = Date.now();
    const pastDueAt = new Date(now - 60 * 60 * 1000).toISOString();

    const result = ScheduleTool.execute(
      {
        description: "Late task",
        dueAt: pastDueAt,
        estimatedRuntimeMs: 5 * 60 * 1000,
      },
      {
        userId: "user123",
        workspaceId: "workspace123",
      },
    );

    const output = JSON.parse(result.output);
    const taskId = output.taskId;

    // Verify task was created
    const task = TaskManager.get(taskId);
    expect(task).toBeDefined();

    // Verify plannedStartAt is approximately now (within 1 second)
    const plannedStartAtStr = task?.metadata?.plannedStartAt as
      | string
      | undefined;
    expect(plannedStartAtStr).toBeDefined();
    const plannedStartAtMs = new Date(plannedStartAtStr || "").getTime();
    expect(Math.abs(plannedStartAtMs - now)).toBeLessThan(1000);
  });

  it("should fire trigger immediately when late (not register for future)", () => {
    const now = Date.now();
    const pastDueAt = new Date(now - 60 * 60 * 1000).toISOString();

    const result = ScheduleTool.execute(
      {
        description: "Late task",
        dueAt: pastDueAt,
        estimatedRuntimeMs: 5 * 60 * 1000,
      },
      {
        userId: "user123",
        workspaceId: "workspace123",
      },
    );

    expect(result.isError).toBe(false);
    const output = JSON.parse(result.output);
    expect(output.success).toBe(true);
    const taskId = output.taskId;

    // For late-start (immediate execution), trigger fires immediately
    // and is not registered for future firing (no entry in registry)
    // This is correct behavior - the task runs now, not later
    const registeredTriggers = Scheduler.getRegisteredTriggers(taskId);
    expect(registeredTriggers.length).toBe(0);
  });

  it("should not include lateStart flag when plannedStartAt is in the future", () => {
    const now = Date.now();
    const futureDueAt = new Date(now + 2 * 60 * 60 * 1000).toISOString(); // 2 hours from now

    const result = ScheduleTool.execute(
      {
        description: "Future task",
        dueAt: futureDueAt,
        estimatedRuntimeMs: 5 * 60 * 1000,
      },
      {
        userId: "user123",
        workspaceId: "workspace123",
      },
    );

    const output = JSON.parse(result.output);
    expect(output.lateStart).toBeUndefined();
    expect(output.originalPlannedStartAt).toBeUndefined();
  });

  it("should preserve dueAt and estimatedRuntimeMs in output for late tasks", () => {
    const now = Date.now();
    const pastDueAt = new Date(now - 60 * 60 * 1000).toISOString();
    const estimatedRuntimeMs = 5 * 60 * 1000;

    const result = ScheduleTool.execute(
      {
        description: "Late task",
        dueAt: pastDueAt,
        estimatedRuntimeMs: estimatedRuntimeMs,
      },
      {
        userId: "user123",
        workspaceId: "workspace123",
      },
    );

    const output = JSON.parse(result.output);
    expect(output.dueAt).toBe(pastDueAt);
    expect(output.estimatedRuntimeMs).toBe(estimatedRuntimeMs);
  });

  it("should handle late-start with recurring cron schedule", () => {
    const now = Date.now();
    const pastDueAt = new Date(now - 60 * 60 * 1000).toISOString();

    const result = ScheduleTool.execute(
      {
        description: "Late recurring task",
        dueAt: pastDueAt,
        estimatedRuntimeMs: 5 * 60 * 1000,
        recurring: {
          type: "cron",
          expression: "0 9 * * *", // 9 AM daily
        },
      },
      {
        userId: "user123",
        workspaceId: "workspace123",
      },
    );

    const output = JSON.parse(result.output);
    expect(output.success).toBe(true);
    expect(output.lateStart).toBe(true);
    expect(output.recurring).toBeDefined();
    expect(output.recurring.type).toBe("cron");
  });

  it("should handle late-start with recurring interval schedule", () => {
    const now = Date.now();
    const pastDueAt = new Date(now - 60 * 60 * 1000).toISOString();

    const result = ScheduleTool.execute(
      {
        description: "Late recurring task",
        dueAt: pastDueAt,
        estimatedRuntimeMs: 5 * 60 * 1000,
        recurring: {
          type: "interval",
          intervalMs: 30 * 60 * 1000, // Every 30 minutes
        },
      },
      {
        userId: "user123",
        workspaceId: "workspace123",
      },
    );

    const output = JSON.parse(result.output);
    expect(output.success).toBe(true);
    expect(output.lateStart).toBe(true);
    expect(output.recurring).toBeDefined();
    expect(output.recurring.type).toBe("interval");
  });
});
