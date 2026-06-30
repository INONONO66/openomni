import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { WorkerRunContract } from "./worker-run.js";

const BaseEvent = z.object({
  traceId: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  time: z.number(),
});

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

  export const WorkerRunStatus = WorkerRunContract.Status;
  export type WorkerRunStatus = WorkerRunContract.Status;

  export const WorkerRun = WorkerRunContract.Info;
  export type WorkerRun = WorkerRunContract.Info;

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

  export const BackgroundTaskStatus = z.enum([
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
  ]);
  export type BackgroundTaskStatus = z.infer<typeof BackgroundTaskStatus>;

  export const BackgroundTaskConfig = z.object({
    maxConcurrentPerAgent: z.number().int().positive().optional(),
    maxConcurrentTotal: z.number().int().positive().optional(),
    maxDepth: z.number().int().positive().optional(),
    maxDescendants: z.number().int().positive().optional(),
    taskTtlMs: z.number().int().positive().optional(),
  });
  export type BackgroundTaskConfig = z.infer<typeof BackgroundTaskConfig>;

  export const BackgroundTask = z.object({
    id: z.string(),
    agentName: z.string(),
    prompt: z.string(),
    status: BackgroundTaskStatus,
    parentSessionId: z.string(),
    sessionId: z.string().optional(),
    runId: z.string().optional(),
    queuedAt: z.number(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    error: z.string().optional(),
    depth: z.number(),
  });
  export type BackgroundTask = z.infer<typeof BackgroundTask>;

  export const BackgroundTaskResult = z.object({
    taskId: z.string(),
    status: BackgroundTaskStatus,
    output: z.string().optional(),
  });
  export type BackgroundTaskResult = z.infer<typeof BackgroundTaskResult>;

  export namespace Events {
    export const WorkerSessionSpawned = BusEvent.define(
      "worker.session.spawned",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          parentSessionId: z.string().optional(),
          agentName: z.string(),
          spawnDepth: z.number().int().min(0),
          kind: ChildSessionKind,
        }),
      }),
      { visibility: "internal" },
    );

    export const WorkerRunStarted = BusEvent.define(
      "worker.run.started",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
          title: z.string(),
        }),
      }),
      { visibility: "ephemeral" },
    );

    export const WorkerRunCompleted = BusEvent.define(
      "worker.run.completed",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
          status: WorkerRunStatus,
        }),
      }),
      { visibility: "llm_reason" },
    );

    export const WorkerRunFailed = BusEvent.define(
      "worker.run.failed",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
          error: z.string().optional(),
        }),
      }),
      { visibility: "llm_reason" },
    );

    export const WorkerSessionResumed = BusEvent.define(
      "worker.session.resumed",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
        }),
      }),
      { visibility: "internal" },
    );

    export const WorkerSessionCancelled = BusEvent.define(
      "worker.session.cancelled",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string().optional(),
        }),
      }),
      { visibility: "llm_reason" },
    );

    export const WorkerConsultationRequested = BusEvent.define(
      "worker.consultation.requested",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
          targetAgent: z.string(),
          mode: ConsultationMode,
        }),
      }),
      { visibility: "ephemeral" },
    );

    export const WorkerConsultationCompleted = BusEvent.define(
      "worker.consultation.completed",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
          consultationId: z.string(),
        }),
      }),
      { visibility: "llm_reason" },
    );

    export const BackgroundTaskLaunched = BusEvent.define(
      "background.task.launched",
      BaseEvent.extend({
        payload: z.object({
          taskId: z.string(),
          agentName: z.string(),
          parentSessionId: z.string(),
          status: BackgroundTaskStatus,
        }),
      }),
      { visibility: "ephemeral" },
    );

    export const BackgroundTaskCompleted = BusEvent.define(
      "background.task.completed",
      BaseEvent.extend({
        payload: z.object({
          taskId: z.string(),
          status: BackgroundTaskStatus,
          sessionId: z.string().optional(),
        }),
      }),
      { visibility: "llm_reason" },
    );

    export const BackgroundTaskFailed = BusEvent.define(
      "background.task.failed",
      BaseEvent.extend({
        payload: z.object({
          taskId: z.string(),
          error: z.string().optional(),
        }),
      }),
      { visibility: "llm_reason" },
    );

    export const BackgroundTaskCancelled = BusEvent.define(
      "background.task.cancelled",
      BaseEvent.extend({
        payload: z.object({
          taskId: z.string(),
        }),
      }),
      { visibility: "llm_reason" },
    );
  }
}
