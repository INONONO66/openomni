import { z } from "zod";

export namespace Task {
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

  export const RunStatus = Status.exclude(["idle"]);
  export type RunStatus = z.infer<typeof RunStatus>;

  export const Owner = z.object({
    type: z.enum(["user", "agent"]),
    id: z.string(),
  });
  export type Owner = z.infer<typeof Owner>;

  export const Info = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    owner: Owner,
    assignedAgentId: z.string().optional(),
    status: Status,
    tags: z.array(z.string()).optional(),
  });
  export type Info = z.infer<typeof Info>;

  export const Trigger = z.object({
    id: z.string(),
    type: z.enum(["cron", "interval", "once", "event", "manual"]),
  });
  export type Trigger = z.infer<typeof Trigger>;

  export const Context = z.object({
    conversationSessionId: z.string().optional(),
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
    traceId: z.string().optional(),
  });
  export type Context = z.infer<typeof Context>;

  export const Checkpoint = z.object({
    step: z.string(),
    data: z.record(z.unknown()),
    savedAt: z.number(),
  });
  export type Checkpoint = z.infer<typeof Checkpoint>;

  export const SpawnedBy = z.object({
    taskId: z.string(),
    runId: z.string(),
    sessionId: z.string(),
  });
  export type SpawnedBy = z.infer<typeof SpawnedBy>;

  export const Run = z.object({
    runId: z.string(),
    taskId: z.string(),
    sessionKey: z.string(),
    status: RunStatus,
    trigger: Trigger,
    idempotencyKey: z.string(),
    scheduledAt: z.number(),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
    payload: z.record(z.unknown()).optional(),
    context: Context.optional(),
    attempt: z.number(),
    agentId: z.string().optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    checkpoint: Checkpoint.optional(),
    spawnedBy: SpawnedBy.optional(),
  });
  export type Run = z.infer<typeof Run>;
}
