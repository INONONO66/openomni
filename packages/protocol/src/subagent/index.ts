import { z } from "zod";

export namespace Subagent {
  export const ChildSessionKind = z.enum(["subagent", "team-worker", "consultation"]);
  export type ChildSessionKind = z.infer<typeof ChildSessionKind>;

  export const ChildSessionStatus = z.enum([
    "idle",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  export type ChildSessionStatus = z.infer<typeof ChildSessionStatus>;

  export const ChildSessionMeta = z.object({
    kind: ChildSessionKind,
    parentSessionId: z.string().optional(),
    parentRunId: z.string().optional(),
    agentName: z.string(),
    spawnDepth: z.number().int().min(0).default(0),
    status: ChildSessionStatus,
  });
  export type ChildSessionMeta = z.infer<typeof ChildSessionMeta>;

  export const WorkerRunStatus = z.enum([
    "queued",
    "starting",
    "running",
    "waiting_input",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  export type WorkerRunStatus = z.infer<typeof WorkerRunStatus>;

  export const WorkerRun = z.object({
    runId: z.string(),
    sessionId: z.string(),
    parentRunId: z.string().optional(),
    assignedStepId: z.string().optional(),
    title: z.string(),
    prompt: z.string(),
    status: WorkerRunStatus,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    lastMessageId: z.string().optional(),
    resumeCount: z.number().int().min(0).default(0),
  });
  export type WorkerRun = z.infer<typeof WorkerRun>;

  export const SpawnConfig = z.object({
    parentSessionId: z.string().optional(),
    agentName: z.string(),
    title: z.string(),
    prompt: z.string(),
    category: z.string().optional(),
    spawnDepth: z.number().int().min(0).default(0),
  });
  export type SpawnConfig = z.infer<typeof SpawnConfig>;

  export const ConsultationMode = z.enum(["fresh-session", "active-session"]);
  export type ConsultationMode = z.infer<typeof ConsultationMode>;

  export const ConsultationRequest = z
    .object({
      sessionId: z.string(),
      runId: z.string(),
      question: z.string(),
      targetAgent: z.string(),
      mode: ConsultationMode,
      targetSessionId: z.string().optional(),
    })
    .superRefine((value, context) => {
      if (value.mode === "active-session" && !value.targetSessionId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targetSessionId"],
          message: "targetSessionId is required for active-session mode",
        });
      }
    });
  export type ConsultationRequest = z.infer<typeof ConsultationRequest>;

  export const ConsultationResult = z.object({
    consultationId: z.string(),
    guidance: z.string(),
    source: z.string(),
    mode: ConsultationMode,
  });
  export type ConsultationResult = z.infer<typeof ConsultationResult>;
}
