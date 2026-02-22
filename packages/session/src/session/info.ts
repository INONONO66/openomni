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
    archived: z.number().optional(),
  }),
  expiresAt: z.number().optional(),
  agent: z
    .object({
      id: z.string(),
      name: z.string().optional(),
    })
    .optional(),
  tokens: z
    .object({
      input: z.number(),
      output: z.number(),
      total: z.number(),
    })
    .optional(),
  messageCount: z.number().optional(),
  summary: z.string().optional(),
  projectId: z.string().optional(),
});

export type SessionInfo = z.infer<typeof SessionInfo>;
