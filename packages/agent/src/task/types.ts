import { z } from "zod";
import { RetryPolicy, RunBudget } from "@openomni/protocol";

/**
 * Task namespace - types for task automation system
 * Implements spec section 3.2: Task Model
 */
export namespace Task {
  // ============================================================
  // Status
  // ============================================================

  export const Status = z.enum([
    "idle",
    "scheduled",
    "running",
    "blocked",
    "done",
    "failed",
    "cancelled",
  ]);
  export type Status = z.infer<typeof Status>;

  // ============================================================
  // Concurrency
  // ============================================================

  export const Concurrency = z.object({
    maxRunning: z.number().int().positive(),
    mode: z.enum(["queue", "drop"]),
  });
  export type Concurrency = z.infer<typeof Concurrency>;

  // ============================================================
  // Dedupe
  // ============================================================

  export const Dedupe = z.object({
    windowMs: z.number().int().positive(),
  });
  export type Dedupe = z.infer<typeof Dedupe>;

  // ============================================================
  // RateLimit
  // ============================================================

  export const RateLimit = z.object({
    maxPerWindow: z.number().int().positive(),
    windowMs: z.number().int().positive(),
  });
  export type RateLimit = z.infer<typeof RateLimit>;

  // ============================================================
  // Trigger (discriminated union by type)
  // ============================================================

  const TriggerBase = z.object({
    id: z.string(),
  });

  export const TriggerCron = TriggerBase.extend({
    type: z.literal("cron"),
    expr: z.string(),
  });
  export type TriggerCron = z.infer<typeof TriggerCron>;

  export const TriggerInterval = TriggerBase.extend({
    type: z.literal("interval"),
    ms: z.number().int().positive(),
  });
  export type TriggerInterval = z.infer<typeof TriggerInterval>;

  export const TriggerOnce = TriggerBase.extend({
    type: z.literal("once"),
    at: z.number().int().positive(),
  });
  export type TriggerOnce = z.infer<typeof TriggerOnce>;

  export const TriggerEvent = TriggerBase.extend({
    type: z.literal("event"),
    name: z.string(),
    filter: z.lazy(() => TriggerFilter).optional(),
  });
  export type TriggerEvent = z.infer<typeof TriggerEvent>;

  export const TriggerManual = TriggerBase.extend({
    type: z.literal("manual"),
  });
  export type TriggerManual = z.infer<typeof TriggerManual>;

  export const Trigger = z.discriminatedUnion("type", [
    TriggerCron,
    TriggerInterval,
    TriggerOnce,
    TriggerEvent,
    TriggerManual,
  ]);
  export type Trigger = z.infer<typeof Trigger>;

  // ============================================================
  // TriggerFilter
  // ============================================================

  export const TriggerFilterCondition = z.object({
    path: z.string(),
    op: z.enum([
      "eq",
      "neq",
      "in",
      "nin",
      "exists",
      "regex",
      "gt",
      "gte",
      "lt",
      "lte",
    ]),
    value: z.unknown().optional(),
  });
  export type TriggerFilterCondition = z.infer<typeof TriggerFilterCondition>;

  export const TriggerFilter = z.object({
    conditions: z.array(TriggerFilterCondition),
    mode: z.enum(["all", "any"]).default("all"),
  });
  export type TriggerFilter = z.infer<typeof TriggerFilter>;

  // ============================================================
  // Owner
  // ============================================================

  export const Owner = z.object({
    type: z.enum(["user", "agent"]),
    id: z.string(),
  });
  export type Owner = z.infer<typeof Owner>;

  // ============================================================
  // ExecutionPolicy
  // ============================================================

  export const ExecutionPolicy = z.object({
    permission: z.enum(["ask", "notify", "deny"]).optional(),
    retry: RetryPolicy.optional(),
    concurrency: Concurrency.optional(),
    dedupe: Dedupe.optional(),
    rateLimit: RateLimit.optional(),
    budget: RunBudget.optional(),
    toolAllowlist: z.array(z.string()).optional(),
    toolDenylist: z.array(z.string()).optional(),
  });
  export type ExecutionPolicy = z.infer<typeof ExecutionPolicy>;

  // ============================================================
  // Info
  // ============================================================

  export const Info = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    owner: Owner,
    assignedAgentId: z.string().optional(),
    status: Status,
    triggers: z.array(Trigger),
    policy: ExecutionPolicy,
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastRun: z.lazy(() => TaskRun).optional(),
    history: z.array(z.lazy(() => TaskRun)).optional(),
    pendingRun: z.lazy(() => TaskRun).optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  export type Info = z.infer<typeof Info>;

  // ============================================================
  // CreateInput
  // ============================================================

  export const CreateInput = z.object({
    title: z.string(),
    description: z.string().optional(),
    owner: Owner,
    assignedAgentId: z.string().optional(),
    triggers: z.array(Trigger).optional(),
    policy: ExecutionPolicy.partial().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  export type CreateInput = z.infer<typeof CreateInput>;

  // ============================================================
  // UpdateInput
  // ============================================================

  export const UpdateInput = CreateInput.partial().extend({
    status: Status.optional(),
  });
  export type UpdateInput = z.infer<typeof UpdateInput>;
}

// ============================================================
// TaskRun (execution instance)
// ============================================================

export const TaskRun = z.object({
  runId: z.string(),
  taskId: z.string(),
  sessionKey: z.string(), // SessionKey pattern: task:${string}:run:${string}
  status: z.enum([
    "scheduled",
    "running",
    "blocked",
    "done",
    "failed",
    "cancelled",
  ]),
  trigger: z.object({
    id: z.string(),
    type: z.enum(["cron", "interval", "once", "event", "manual"]),
  }),
  idempotencyKey: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  context: z
    .object({
      conversationSessionId: z.string().optional(),
      userId: z.string().optional(),
      workspaceId: z.string().optional(),
      traceId: z.string().optional(),
    })
    .optional(),
  attempt: z.number().int().positive(),
  agentId: z.string().optional(),
  scheduledAt: z.number().int(),
  startedAt: z.number().int().optional(),
  endedAt: z.number().int().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  checkpoint: z
    .object({
      step: z.string(),
      data: z.record(z.string(), z.unknown()),
      savedAt: z.number().int(),
    })
    .optional(),
});
export type TaskRun = z.infer<typeof TaskRun>;

// ============================================================
// TriggerSignal (runtime trigger event)
// ============================================================

export const TriggerSignal = z.object({
  triggerId: z.string(),
  type: z.enum(["cron", "interval", "once", "event", "manual"]),
  payload: z.record(z.string(), z.unknown()).optional(),
  context: z
    .object({
      conversationSessionId: z.string().optional(),
      userId: z.string().optional(),
      workspaceId: z.string().optional(),
      traceId: z.string().optional(),
    })
    .optional(),
  occurredAt: z.number().int(),
});
export type TriggerSignal = z.infer<typeof TriggerSignal>;
