import { z } from "zod";
import { TaskManager, Task } from "../task";
import { Scheduler } from "../trigger";
import type { Tool } from "@openomni/protocol";
import { randomUUID } from "crypto";

export const ScheduleInput = z.object({
  description: z.string().describe("Task description"),
  dueAt: z.string().datetime().describe("ISO 8601 datetime for execution"),
  estimatedRuntimeMs: z
    .number()
    .positive()
    .describe("Estimated runtime in milliseconds"),
  recurring: z
    .object({
      type: z.enum(["cron", "interval", "once"]).describe("Recurrence type"),
      expression: z
        .string()
        .optional()
        .describe("Cron expression (for cron type)"),
      intervalMs: z
        .number()
        .optional()
        .describe("Interval in milliseconds (for interval type)"),
    })
    .optional()
    .describe("Recurrence configuration (optional)"),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

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
  ): Tool.Result {
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
      let plannedStartAtMs =
        dueAtMs - validated.estimatedRuntimeMs - SAFETY_BUFFER_MS;

      // Handle late-start: if plannedStartAt is in the past, execute immediately
      const now = Date.now();
      let isLateStart = false;
      let originalPlannedStartAt: string | undefined;

      if (plannedStartAtMs <= now) {
        isLateStart = true;
        originalPlannedStartAt = new Date(plannedStartAtMs).toISOString();
        plannedStartAtMs = now; // Execute immediately
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

      const createdTask = TaskManager.create(taskInput, {
        executionContext: undefined,
        intent: "durable",
      });

      // Create trigger based on recurring configuration
      const triggerId = randomUUID();
      let trigger: Task.Trigger;
      let recurringInfo: Record<string, unknown> = {};

      if (validated.recurring) {
        switch (validated.recurring.type) {
          case "cron": {
            if (!validated.recurring.expression) {
              return {
                id: randomUUID(),
                toolCallId: "",
                output: JSON.stringify({
                  error: "invalid_cron_config",
                  message: "Cron recurring type requires expression field",
                }),
                isError: true,
              };
            }
            trigger = {
              id: triggerId,
              type: "cron",
              expr: validated.recurring.expression,
            };
            recurringInfo = {
              type: "cron",
              expression: validated.recurring.expression,
            };
            break;
          }

          case "interval": {
            if (!validated.recurring.intervalMs) {
              return {
                id: randomUUID(),
                toolCallId: "",
                output: JSON.stringify({
                  error: "invalid_interval_config",
                  message: "Interval recurring type requires intervalMs field",
                }),
                isError: true,
              };
            }
            trigger = {
              id: triggerId,
              type: "interval",
              ms: validated.recurring.intervalMs,
            };
            recurringInfo = {
              type: "interval",
              intervalMs: validated.recurring.intervalMs,
            };
            break;
          }

          case "once":
          default: {
            trigger = {
              id: triggerId,
              type: "once",
              at: plannedStartAtMs,
            };
            break;
          }
        }
      } else {
        // No recurring specified, use once trigger
        trigger = {
          id: triggerId,
          type: "once",
          at: plannedStartAtMs,
        };
      }

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
      const response: Record<string, unknown> = {
        success: true,
        taskId: createdTask.id,
        plannedStartAt: new Date(plannedStartAtMs).toISOString(),
        dueAt: validated.dueAt,
        estimatedRuntimeMs: validated.estimatedRuntimeMs,
        safetyBufferMs: SAFETY_BUFFER_MS,
      };

      // Include late-start flag and original planned start time if applicable
      if (isLateStart) {
        response.lateStart = true;
        response.originalPlannedStartAt = originalPlannedStartAt;
      }

      // Include recurring info if present
      if (Object.keys(recurringInfo).length > 0) {
        response.recurring = recurringInfo;
      }

      return {
        id: randomUUID(),
        toolCallId: "",
        output: JSON.stringify(response),
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
