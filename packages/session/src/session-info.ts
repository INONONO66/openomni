import { z } from "zod";

export const SessionInfo = z.object({
  id: z.string(),
  title: z.string(),
  model: z.object({
    providerID: z.string(),
    modelID: z.string(),
  }),
  time: z.object({
    created: z.number(),
    updated: z.number(),
  }),
  expiresAt: z.number().optional(),
});

export type SessionInfo = z.infer<typeof SessionInfo>;
