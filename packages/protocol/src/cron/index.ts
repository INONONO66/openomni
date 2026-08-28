import { z } from "zod";
import { EpochMs } from "../time.js";

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
    createdAt: EpochMs,
    nextFireAt: EpochMs.optional(),
  });
  export type Info = z.infer<typeof Info>;
}
