import { z } from "zod";

export namespace Run {
  export const Snapshot = z.object({
    id: z.string(),
    sessionID: z.string(),
    timestamp: z.number(),
    state: z.record(z.string(), z.unknown()),
  });
  export type Snapshot = z.infer<typeof Snapshot>;

  export const Outcome = z.discriminatedUnion("type", [
    z.object({ type: z.literal("stop") }),
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

  export const Budget = z.object({
    maxWallTimeMs: z.number(),
    maxTurns: z.number(),
    maxToolCalls: z.number(),
    maxToolRuntimeMs: z.number(),
  });
  export type Budget = z.infer<typeof Budget>;
}
