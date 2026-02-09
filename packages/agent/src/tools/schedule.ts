import { ScheduleInput } from "./schemas";
import { TaskManager } from "../task/manager";
import { Scheduler } from "../trigger/scheduler";
import { Task } from "../task/types";
import { ToolResult } from "@openomni/protocol";
import { randomUUID } from "crypto";

/**
 * Schedule tool — creates a task scheduled for future execution
 * Calculates plannedStartAt based on dueAt and estimatedRuntimeMs
 * Enforces task-from-task prohibition
 */
export namespace ScheduleTool {
  const SAFETY_BUFFER_MS = 2 * 60 * 1000; // 2 minutes

  /**
   * Execute schedule tool
   * @param input - ScheduleInput (description, dueAt, estimatedRuntimeMs, recurring)
   * @param context - Execution context with session info
   * @returns ToolResult with taskId, plannedStartAt, dueAt
   */
  export function execute(
    input: unknown,
    context: {
      sessionType?: string;
      sessionId?: string;
      userId?: string;
      workspaceId?: string;
    },
  ): ToolResult {
    // Validate input against ScheduleInput schema
    let validated: ScheduleInput;
    try {
      validated = ScheduleInput.parse(input);
    } catch (error) {
      return {
        id: randomUUID(),
        toolCallId: "",
        output: JSON.stringify({
          error: "invalid_input",
          message: `Invalid schedule input: ${error instanceof Error ? error.message : String(error)}`,
        }),
        isError: true,
      };
    }

    // Enforce task-from-task prohibition
    if (context.sessionType === "task") {
      return {
        id: randomUUID(),
        toolCallId: "",
        output: JSON.stringify({
          error: "task_from_task_prohibited",
          message:
            "Cannot schedule a task from within a task execution context",
        }),
        isError: true,
      };
    }

    try {
      // Parse dueAt ISO 8601 string to milliseconds
      const dueAtMs = new Date(validated.dueAt).getTime();
      if (isNaN(dueAtMs)) {
        return {
          id: randomUUID(),
          toolCallId: "",
          output: JSON.stringify({
            error: "invalid_datetime",
            message: `Invalid dueAt datetime: ${validated.dueAt}`,
          }),
          isError: true,
        };
      }

      // Calculate plannedStartAt = dueAt - estimatedRuntimeMs - safetyBufferMs
      const plannedStartAtMs =
        dueAtMs - validated.estimatedRuntimeMs - SAFETY_BUFFER_MS;

      // Validate plannedStartAt is in the future
      const now = Date.now();
      if (plannedStartAtMs <= now) {
        return {
          id: randomUUID(),
          toolCallId: "",
          output: JSON.stringify({
            error: "start_time_in_past",
            message: `Calculated plannedStartAt (${new Date(plannedStartAtMs).toISOString()}) is in the past. Increase dueAt or decrease estimatedRuntimeMs.`,
          }),
          isError: true,
        };
      }

      // Create task via TaskManager.create()
      const taskInput: Task.CreateInput = {
        title: validated.description,
        description: validated.description,
        owner: {
          type: context.userId ? "user" : "agent",
          id: context.userId || "system",
        },
        metadata: {
          estimatedRuntimeMs: validated.estimatedRuntimeMs,
          dueAt: validated.dueAt,
          plannedStartAt: new Date(plannedStartAtMs).toISOString(),
        },
      };

      const createdTask = TaskManager.create(taskInput);

      // Create trigger for the scheduled time
      const triggerId = randomUUID();
      const trigger: Task.TriggerOnce = {
        id: triggerId,
        type: "once",
        at: plannedStartAtMs,
      };

      // Register trigger with Scheduler
      const registered = Scheduler.registerTrigger(createdTask.id, trigger);
      if (!registered) {
        return {
          id: randomUUID(),
          toolCallId: "",
          output: JSON.stringify({
            error: "scheduler_registration_failed",
            message: `Failed to register trigger with scheduler for task ${createdTask.id}`,
          }),
          isError: true,
        };
      }

      // Return confirmation
      return {
        id: randomUUID(),
        toolCallId: "",
        output: JSON.stringify({
          success: true,
          taskId: createdTask.id,
          plannedStartAt: new Date(plannedStartAtMs).toISOString(),
          dueAt: validated.dueAt,
          estimatedRuntimeMs: validated.estimatedRuntimeMs,
          safetyBufferMs: SAFETY_BUFFER_MS,
        }),
        isError: false,
      };
    } catch (error) {
      return {
        id: randomUUID(),
        toolCallId: "",
        output: JSON.stringify({
          error: "execution_error",
          message: `Schedule tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
        isError: true,
      };
    }
  }
}
