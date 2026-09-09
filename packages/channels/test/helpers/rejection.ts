import type { z } from "zod";

/** Parse the rejected value at the promise boundary; successful operations fail the assertion. */
export function rejected<T, E extends Error>(
  operation: Promise<T>,
  schema: z.ZodType<E>,
): Promise<E> {
  return operation.then(() => {
    throw new Error("expected the operation to reject");
  }, schema.parse);
}
