import { z } from "zod";

export namespace Artifact {
  const nonEmptyString = z.string().refine((value) => value.trim().length > 0);

  export const Meta = z.object({
    id: nonEmptyString,
    sessionId: nonEmptyString,
    mimeType: nonEmptyString,
    title: nonEmptyString,
    version: z.number().int().positive().default(1),
    createdAt: nonEmptyString,
  });
  export type Meta = z.infer<typeof Meta>;
}
