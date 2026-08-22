import { z } from "zod";

export namespace Artifact {
  export const Meta = z.object({
    id: z.string(),
    sessionId: z.string(),
    mimeType: z.string().refine((value) => value.trim().length > 0),
    title: z.string(),
    version: z.number().int().positive().default(1),
    createdAt: z.string().refine((value) => value.trim().length > 0),
  });
  export type Meta = z.infer<typeof Meta>;
}
