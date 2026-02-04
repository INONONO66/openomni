import { z } from "zod";

export namespace Tool {
  export const StatePending = z.object({
    status: z.literal("pending"),
    input: z.record(z.string(), z.any()),
  });
  export type StatePending = z.infer<typeof StatePending>;

  export const StateRunning = z.object({
    status: z.literal("running"),
    input: z.record(z.string(), z.any()),
    time: z.object({
      start: z.number(),
    }),
  });
  export type StateRunning = z.infer<typeof StateRunning>;

  export const StateCompleted = z.object({
    status: z.literal("completed"),
    input: z.record(z.string(), z.any()),
    output: z.string(),
    title: z.string(),
    metadata: z.record(z.string(), z.any()),
    time: z.object({
      start: z.number(),
      end: z.number(),
    }),
  });
  export type StateCompleted = z.infer<typeof StateCompleted>;

  export const StateError = z.object({
    status: z.literal("error"),
    input: z.record(z.string(), z.any()),
    error: z.string(),
    time: z.object({
      start: z.number(),
      end: z.number(),
    }),
  });
  export type StateError = z.infer<typeof StateError>;

  export const State = z.discriminatedUnion("status", [
    StatePending,
    StateRunning,
    StateCompleted,
    StateError,
  ]);
  export type State = z.infer<typeof State>;
}
