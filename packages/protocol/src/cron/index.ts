import { z } from "zod";

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
}
