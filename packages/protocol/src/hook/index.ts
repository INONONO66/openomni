import { z } from "zod";

export namespace Hook {
  export const Timing = z.enum([
    "pre_tool_use",
    "post_tool_use",
    "pre_turn",
    "post_turn",
    "on_error",
  ]);
  export type Timing = z.infer<typeof Timing>;

  export const Verdict = z.discriminatedUnion("action", [
    z.object({ action: z.literal("continue") }),
    z.object({ action: z.literal("skip"), reason: z.string().optional() }),
    z.object({ action: z.literal("abort"), reason: z.string().optional() }),
    z.object({ action: z.literal("retry"), reason: z.string().optional() }),
    z.object({
      action: z.literal("transform"),
      input: z.record(z.string(), z.unknown()),
    }),
    z.object({
      action: z.literal("inject"),
      message: z.string(),
    }),
  ]);
  export type Verdict = z.infer<typeof Verdict>;
}
