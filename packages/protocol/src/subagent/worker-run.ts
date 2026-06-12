import { z } from "zod";
import { WorkItem } from "../work-item/index.js";

export namespace WorkerRunContract {
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
}
