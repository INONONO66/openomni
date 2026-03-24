import { z } from "zod";

export namespace Artifact {
  export const Meta = z.object({
    id: z.string(),
    sessionId: z.string(),
    mimeType: z.string(),
    title: z.string(),
    version: z.number().int().default(1),
    createdAt: z.string(),
  });
  export type Meta = z.infer<typeof Meta>;

  export const Part = z.object({
    type: z.literal("artifact"),
    artifactId: z.string(),
    meta: Meta,
  });
  export type Part = z.infer<typeof Part>;
}
