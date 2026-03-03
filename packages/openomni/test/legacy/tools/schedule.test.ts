import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ScheduleTool } from "../../../src/legacy/tools/schedule";
import { TaskManager } from "../../../src/legacy/task/manager";
import { Scheduler } from "../../../src/legacy/trigger/scheduler";
import { TaskStorage } from "../../../src/legacy/task/storage";

describe("ScheduleTool", () => {
  beforeEach(() => {
    TaskStorage.reset();
    Scheduler.clear();
  });

  afterEach(() => {
    Scheduler.clear();
  });

  describe("execute", () => {
    it("should schedule a task with correct plannedStartAt calculation", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000; // 1 hour from now
      const estimatedRuntimeMs = 20 * 60 * 1000; // 20 minutes
      const safetyBufferMs = 2 * 60 * 1000; // 2 minutes

      const input = {
        description: "Test task",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs,
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);
      expect(output.success).toBe(true);
      expect(output.taskId).toBeDefined();
      expect(output.plannedStartAt).toBeDefined();
      expect(output.dueAt).toBe(input.dueAt);
      expect(output.estimatedRuntimeMs).toBe(estimatedRuntimeMs);
      expect(output.safetyBufferMs).toBe(safetyBufferMs);

      // Verify plannedStartAt calculation
      const plannedStartAtMs = new Date(output.plannedStartAt).getTime();
      const expectedPlannedStartAtMs =
        dueAtMs - estimatedRuntimeMs - safetyBufferMs;
      expect(plannedStartAtMs).toBe(expectedPlannedStartAtMs);
    });

    it("should create task with metadata containing estimatedRuntimeMs and dueAt", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;
      const estimatedRuntimeMs = 15 * 60 * 1000;

      const input = {
        description: "Metadata test",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs,
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      const taskId = output.taskId;

      const task = TaskManager.get(taskId);
      expect(task).toBeDefined();
      expect(task?.metadata?.estimatedRuntimeMs).toBe(estimatedRuntimeMs);
      expect(task?.metadata?.dueAt).toBe(input.dueAt);
      expect(task?.metadata?.plannedStartAt).toBeDefined();
    });

    it("should register trigger with Scheduler", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Scheduler test",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      const taskId = output.taskId;

      // Verify scheduler has registered triggers for this task
      const registeredTriggers = Scheduler.getRegisteredTriggers(taskId);
      expect(registeredTriggers.length).toBeGreaterThan(0);
    });

    it("should reject task-from-task context", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Task from task",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
      };

      const result = ScheduleTool.execute(input, {
        sessionType: "task",
        sessionId: "task:123:run:456",
      });

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.error).toBe("task_from_task_prohibited");
      expect(output.message).toContain(
        "Cannot schedule a task from within a task execution context",
      );
    });

    it("should reject invalid input schema", () => {
      const input = {
        description: "Invalid input",
        // Missing dueAt and estimatedRuntimeMs
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.error).toBe("invalid_input");
    });

    it("should reject invalid ISO 8601 datetime", () => {
      const input = {
        description: "Invalid datetime",
        dueAt: "not-a-valid-datetime",
        estimatedRuntimeMs: 10 * 60 * 1000,
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.error).toBe("invalid_input");
    });

    it("should handle plannedStartAt in the past with late-start execution", () => {
      const now = Date.now();
      const dueAtMs = now + 5 * 60 * 1000; // 5 minutes from now
      const estimatedRuntimeMs = 30 * 60 * 1000; // 30 minutes (longer than time to dueAt)

      const input = {
        description: "Past start time",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs,
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);
      expect(output.success).toBe(true);
      expect(output.lateStart).toBe(true);
      expect(output.originalPlannedStartAt).toBeDefined();
    });

    it("should handle positive estimatedRuntimeMs validation", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Zero runtime",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 0, // Invalid: must be positive
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.error).toBe("invalid_input");
    });

    it("should work with agent owner when no userId provided", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "Agent owner",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
      };

      const result = ScheduleTool.execute(input, {
        // No userId provided
      });

      expect(result.isError).toBe(false);
      const output = JSON.parse(result.output);
      const taskId = output.taskId;

      const task = TaskManager.get(taskId);
      expect(task?.owner.type).toBe("agent");
      expect(task?.owner.id).toBe("system");
    });

    it("should calculate correct plannedStartAt with 2-minute safety buffer", () => {
      const now = Date.now();
      const dueAtMs = now + 2 * 60 * 60 * 1000; // 2 hours from now
      const estimatedRuntimeMs = 45 * 60 * 1000; // 45 minutes
      const safetyBufferMs = 2 * 60 * 1000; // 2 minutes

      const input = {
        description: "Safety buffer test",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs,
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      const output = JSON.parse(result.output);
      const plannedStartAtMs = new Date(output.plannedStartAt).getTime();

      // plannedStartAt should be: dueAt - estimatedRuntime - safetyBuffer
      const expectedMs = dueAtMs - estimatedRuntimeMs - safetyBufferMs;
      expect(plannedStartAtMs).toBe(expectedMs);

      // Verify the math: plannedStartAt + estimatedRuntime + safetyBuffer = dueAt
      const reconstructedDueAt =
        plannedStartAtMs + estimatedRuntimeMs + safetyBufferMs;
      expect(reconstructedDueAt).toBe(dueAtMs);
    });

    it("should return ToolResult with proper structure", () => {
      const now = Date.now();
      const dueAtMs = now + 60 * 60 * 1000;

      const input = {
        description: "ToolResult structure",
        dueAt: new Date(dueAtMs).toISOString(),
        estimatedRuntimeMs: 10 * 60 * 1000,
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.id).toBeDefined();
      expect(result.toolCallId).toBeDefined();
      expect(result.output).toBeDefined();
      expect(result.isError).toBe(false);
      expect(typeof result.output).toBe("string");
    });

    it("should handle execution errors gracefully", () => {
      // Pass invalid input that will cause parsing to fail
      const input = {
        description: "Error handling",
        dueAt: "2025-12-31T23:59:59Z",
        estimatedRuntimeMs: -5, // Negative number should fail validation
      };

      const result = ScheduleTool.execute(input, {
        userId: "user123",
      });

      expect(result.isError).toBe(true);
      const output = JSON.parse(result.output);
      expect(output.error).toBeDefined();
      expect(output.message).toBeDefined();
    });
  });
});
