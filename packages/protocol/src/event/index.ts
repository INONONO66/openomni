import { z } from "zod";
import { BusEvent } from "../bus/index.js";

/**
 * Base event schema with correlation fields
 * All events must include these fields for tracing and correlation
 */
const BaseEvent = z.object({
  traceId: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  time: z.number(),
});

/**
 * Task Events
 * Events related to task lifecycle and execution
 */
export namespace Task {
  // Task lifecycle events
  export const Created = BusEvent.define(
    "task.created",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        status: z.string(),
      }),
    }),
  );

  export const Updated = BusEvent.define(
    "task.updated",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
        changes: z.record(z.unknown()),
      }),
    }),
  );

  export const Deleted = BusEvent.define(
    "task.deleted",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
      }),
    }),
  );

  // Task run events
  export const RunStarted = BusEvent.define(
    "task.run.started",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
        taskId: z.string(),
      }),
    }),
  );

  export const RunCompleted = BusEvent.define(
    "task.run.completed",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
        taskId: z.string(),
        result: z.unknown().optional(),
        duration: z.number(),
      }),
    }),
  );

  export const RunFailed = BusEvent.define(
    "task.run.failed",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
        taskId: z.string(),
        error: z.string(),
        duration: z.number(),
      }),
    }),
  );

  export const RunScheduled = BusEvent.define(
    "task.run.scheduled",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
        taskId: z.string(),
        scheduledTime: z.number(),
      }),
    }),
  );

  export const RunBlocked = BusEvent.define(
    "task.run.blocked",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
        taskId: z.string(),
        reason: z.string(),
      }),
    }),
  );

  export const RunCancelled = BusEvent.define(
    "task.run.cancelled",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
        taskId: z.string(),
        reason: z.string().optional(),
      }),
    }),
  );

  export const RunDeduped = BusEvent.define(
    "task.run.deduped",
    BaseEvent.extend({
      payload: z.object({
        id: z.string(),
        taskId: z.string(),
        originalRunId: z.string(),
      }),
    }),
  );

  // Task summary events
  export const SummaryCreated = BusEvent.define(
    "task.summary.created",
    BaseEvent.extend({
      payload: z.object({
        taskId: z.string(),
        summary: z.string(),
      }),
    }),
  );

  export const SummaryDelivered = BusEvent.define(
    "task.summary.delivered",
    BaseEvent.extend({
      payload: z.object({
        taskId: z.string(),
        deliveredTo: z.string(),
      }),
    }),
  );
}

/**
 * Agent Events
 * Events related to agent actions and decisions
 */
export namespace Agent {
  export const RouterSelected = BusEvent.define(
    "agent.router.selected",
    BaseEvent.extend({
      payload: z.object({
        agentId: z.string(),
        selectedRoute: z.string(),
        confidence: z.number().optional(),
      }),
    }),
  );

  export const PermissionRequested = BusEvent.define(
    "agent.permission.requested",
    BaseEvent.extend({
      payload: z.object({
        agentId: z.string(),
        permission: z.string(),
        resource: z.string().optional(),
      }),
    }),
  );

  export const ToolExecuted = BusEvent.define(
    "agent.tool.executed",
    BaseEvent.extend({
      payload: z.object({
        agentId: z.string(),
        toolName: z.string(),
        input: z.unknown().optional(),
        output: z.unknown().optional(),
        duration: z.number(),
      }),
    }),
  );
}
