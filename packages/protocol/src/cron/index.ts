import { z } from "zod";
import { BusEvent } from "../bus/index.js";

const BaseEvent = z.object({
  traceId: z.string(),
  runId: z.string().optional(),
  sessionId: z.string().optional(),
  time: z.number(),
});

export namespace CronJob {
  export const Target = z.object({
    kind: z.enum(["resident", "worker"]),
    sessionId: z.string().optional(),
  });
  export type Target = z.infer<typeof Target>;

  export const Info = z.object({
    id: z.string(),
    agentName: z.string(),
    payload: z.string(),
    schedule: z.string(),
    target: Target,
    createdAt: z.number(),
    nextFireAt: z.number().optional(),
  });
  export type Info = z.infer<typeof Info>;

  export namespace Events {
    export const CronJobScheduled = BusEvent.define(
      "cron_job.scheduled",
      BaseEvent.extend({
        jobId: z.string(),
        agentName: z.string(),
        schedule: z.string(),
      }),
      { visibility: "llm_reason" },
    );

    export const CronJobFired = BusEvent.define(
      "cron_job.fired",
      BaseEvent.extend({
        jobId: z.string(),
        agentName: z.string(),
      }),
      { visibility: "user_audit" },
    );

    export const CronJobCancelled = BusEvent.define(
      "cron_job.cancelled",
      BaseEvent.extend({
        jobId: z.string(),
      }),
      { visibility: "llm_reason" },
    );
  }
}
