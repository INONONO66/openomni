import { z } from "zod";

/**
 * Tool input schemas for LLM tool call contracts
 * These schemas define the structure of inputs for orchestrator tools
 */

// ============================================================
// SubagentInput - Spawn a subagent for specialized tasks
// ============================================================

export const SubagentInput = z.object({
  agentType: z.string().describe("Agent type: 'explore', 'implement', etc."),
  prompt: z.string().describe("Instruction for the subagent"),
  sessionId: z
    .string()
    .optional()
    .describe("Resume existing session (optional)"),
});
export type SubagentInput = z.infer<typeof SubagentInput>;

// ============================================================
// DispatchInput - Dispatch multiple tasks to agents
// ============================================================

export const DispatchInput = z.object({
  objective: z.string().describe("Overall goal for task dispatch"),
  tasks: z
    .array(
      z.object({
        id: z.string().describe("Unique task identifier"),
        description: z.string().describe("Task description"),
        agentType: z.string().describe("Agent type to execute task"),
        dependencies: z
          .array(z.string())
          .default([])
          .describe("Task IDs this task depends on"),
        fileScope: z
          .array(z.string())
          .default([])
          .describe("Files this task operates on"),
      }),
    )
    .describe("Array of tasks to dispatch"),
});
export type DispatchInput = z.infer<typeof DispatchInput>;

// ============================================================
// ScheduleInput - Schedule a task for future execution
// ============================================================

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
