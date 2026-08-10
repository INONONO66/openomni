import { z } from "zod";
import { BusEvent } from "../bus/index.js";
import { NamedError } from "../error/index.js";
import { WorkItem } from "../work-item/index.js";

const BaseEvent = z.object({
  traceId: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  time: z.number(),
});

export namespace WorkerRun {
  export const Status = z.enum([
    "queued",
    "starting",
    "running",
    "waiting_input",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  export type Status = z.infer<typeof Status>;

  export const Info = z.object({
    runId: z.string(),
    sessionId: z.string(),
    parentRunId: z.string().optional(),
    assignedStepId: z.string().optional(),
    title: z.string(),
    prompt: z.string(),
    executorKind: WorkItem.ExecutorKind.optional(),
    status: Status,
    startedAt: z.number(),
    endedAt: z.number().optional(),
    lastMessageId: z.string().optional(),
    resumeCount: z.number().int().min(0).default(0),
  });
  export type Info = z.infer<typeof Info>;

  export const WriteMethod = z.enum(["create", "updateStatus", "updateStatusIfCurrent"]);
  export type WriteMethod = z.infer<typeof WriteMethod>;

  /**
   * #510 D2b — worker-run is a frozen legacy writer. Its live production
   * consumers cut over to WorkItem attempt facts (`work_item.attempt_*` on
   * the `work:<hash>` owner stream), so every worker-run store write method
   * throws this typed error. Callers branch on `data.code`, never message
   * text. Historical `worker_run_state` rows stay readable through the
   * store's read methods and the upcast-on-read attempt-run view; the
   * archive manifest (script/generate-ledger-archive-manifest.ts) records
   * their range identity and integrity hash.
   */
  export const FrozenError = NamedError.create(
    "WorkerRunFrozenError",
    z.object({
      message: z.string(),
      code: z.literal("worker_run_frozen"),
      method: WriteMethod,
    }),
  );
  export type FrozenError = InstanceType<typeof FrozenError>;

  export namespace Events {
    export const Started = BusEvent.define(
      "worker.run.started",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
          title: z.string(),
        }),
      }),
    );

    export const Completed = BusEvent.define(
      "worker.run.completed",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
          status: Status,
        }),
      }),
    );

    export const Failed = BusEvent.define(
      "worker.run.failed",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
          error: z.string().optional(),
        }),
      }),
    );

    export const Cancelled = BusEvent.define(
      "worker.run.cancelled",
      BaseEvent.extend({
        payload: z.object({
          sessionId: z.string(),
          runId: z.string(),
        }),
      }),
    );
  }
}
