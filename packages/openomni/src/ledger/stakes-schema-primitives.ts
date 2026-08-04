import { z } from "zod";

export function createStakesSchemaPrimitives() {
  return {
    identifier: z.string().min(1).max(256),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sequence: z.number().int().safe().nonnegative(),
  };
}
