import { z } from "zod";
import { BusEvent } from "../bus/index.js";

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
    status: z.string(),
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
    );

    export const WorkerSessionResumed = BusEvent.define(
      "worker.session.resumed",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
        }),
      }),
    );

    export const WorkerSessionCancelled = BusEvent.define(
      "worker.session.cancelled",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string().optional(),
        }),
      }),
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
    );

    export const BackgroundTaskFailed = BusEvent.define(
      "background.task.failed",
      BaseEvent.extend({
        payload: z.object({
          taskId: z.string(),
          error: z.string().optional(),
        }),
      }),
    );

    export const BackgroundTaskCancelled = BusEvent.define(
      "background.task.cancelled",
      BaseEvent.extend({
        payload: z.object({
          taskId: z.string(),
        }),
      }),
    );
  }
}
