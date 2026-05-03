import { z } from "zod";

export namespace Hook {
  export const Timing = z.enum([
    "pre_run",
    "pre_tool_use",
    "post_tool_use",
    "pre_turn",
    "post_turn",
    "on_error",
    "post_compaction",
    "on_system_prompt",
    "post_run",
  ]);
  export type Timing = z.infer<typeof Timing>;

  export const Verdict = z.discriminatedUnion("action", [
    z.object({
      action: z.literal("continue"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("skip"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("abort"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("retry"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("transform"),
      input: z.record(z.string(), z.unknown()),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
    z.object({
      action: z.literal("inject"),
      message: z.string(),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
  ]);
  export type Verdict = z.infer<typeof Verdict>;
}

export namespace Middleware {
  export const FailPolicy = z.enum(["fail-open", "fail-closed"]);
  export type FailPolicy = z.infer<typeof FailPolicy>;

  export const Scope = z.object({
    agentType: z.array(z.string()).optional(),
  });
  export type Scope = z.infer<typeof Scope>;

  export const Definition = z.object({
    name: z.string().min(1),
    timing: z.union([Hook.Timing, z.array(Hook.Timing)]),
    priority: z.number().int().min(0),
    scope: Scope.optional(),
    failPolicy: FailPolicy.optional(),
  });
  export type Definition = z.infer<typeof Definition>;

  export const SystemPromptVerdict = z.object({
    systemPrompt: z.string().optional(),
    prependContext: z.string().optional(),
    appendContext: z.string().optional(),
  });
  export type SystemPromptVerdict = z.infer<typeof SystemPromptVerdict>;
}
