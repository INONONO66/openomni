import { z } from "zod";
import { Events as EventDescriptors } from "../event/agent-execution.js";

export namespace Run {
  export const Outcome = z.discriminatedUnion("type", [
    z.object({ type: z.literal("stop") }),
    z.object({ type: z.literal("continue") }),
    z.object({ type: z.literal("compact") }),
    z.object({ type: z.literal("aborted") }),
    z.object({
      type: z.literal("error"),
      error: z.object({
        message: z.string(),
        name: z.string().optional(),
        stack: z.string().optional(),
      }),
    }),
  ]);
  export type Outcome = z.infer<typeof Outcome>;

  export const RetryPolicy = z.object({
    maxAttempts: z.number(),
    backoffMs: z.object({
      initial: z.number(),
      multiplier: z.number(),
      max: z.number(),
    }),
    retryOn: z
      .array(z.enum(["timeout", "tool_error", "transient_error", "validation_error"]))
      .optional(),
  });
  export type RetryPolicy = z.infer<typeof RetryPolicy>;

  /**
   * #499 observation descriptors — loop-run events published via Bus. The
   * persisted event names stay the historical `agent.*` strings (frozen).
   */
  export const Events = EventDescriptors;
}
