import { z } from "zod";

export namespace PolicyEffects {
  export const PolicyEffectType = z.enum([
    "prompt.append_context",
    "prompt.inject_message",
    "prompt.replace",
    "tool.filter",
    "tool.rewrite_input",
    "tool.rewrite_output",
    "tool.skip_invocation",
    "tool.require_approval",
    "run.abort",
    "run.continue_with_prompt",
    "run.retry_after",
    "run.replace_messages",
    "delegation.set_constraints",
    "delegation.require_approval",
    "audit.annotate",
    "writeback.rewrite",
    "writeback.suppress",
    "runtime.set_timeout",
    "runtime.workspace_lock",
  ]);
  export type PolicyEffectType = z.infer<typeof PolicyEffectType>;

  export const PolicyEffect = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("prompt.append_context"),
      context: z.string(),
    }),
    z.object({
      type: z.literal("prompt.inject_message"),
      message: z.string(),
      role: z.enum(["user", "assistant"]).optional(),
    }),
    z.object({
      type: z.literal("prompt.replace"),
      prompt: z.string(),
    }),
    z.object({
      type: z.literal("tool.filter"),
      toolPattern: z.string(),
    }),
    z.object({
      type: z.literal("tool.rewrite_input"),
      input: z.record(z.string(), z.unknown()),
    }),
    z.object({
      type: z.literal("tool.rewrite_output"),
      output: z.string(),
    }),
    z.object({
      type: z.literal("tool.skip_invocation"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("tool.require_approval"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("run.abort"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("run.continue_with_prompt"),
      prompt: z.string(),
    }),
    z.object({
      type: z.literal("run.retry_after"),
      delayMs: z.number().int().min(0),
      maxRetries: z.number().int().min(1).optional(),
    }),
    z.object({
      type: z.literal("run.replace_messages"),
      messages: z.array(z.unknown()),
    }),
    z.object({
      type: z.literal("delegation.set_constraints"),
      constraints: z.record(z.string(), z.unknown()),
    }),
    z.object({
      type: z.literal("delegation.require_approval"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("audit.annotate"),
      annotation: z.string(),
      severity: z.enum(["info", "warning", "error"]).optional(),
    }),
    z.object({
      type: z.literal("writeback.rewrite"),
      output: z.string(),
    }),
    z.object({
      type: z.literal("writeback.suppress"),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal("runtime.set_timeout"),
      timeoutMs: z.number().int().min(0),
    }),
    z.object({
      type: z.literal("runtime.workspace_lock"),
      required: z.boolean(),
    }),
  ]);
  export type PolicyEffect = z.infer<typeof PolicyEffect>;

  export const PolicyObligation = z.object({
    obligationId: z.string(),
    type: z.enum(["humanApproval", "evidenceRequired", "credentialConfirm"]),
    description: z.string(),
    timeoutMs: z.number().int().min(0).optional(),
    resolvedBy: z.string().optional(),
  });
  export type PolicyObligation = z.infer<typeof PolicyObligation>;

  export const PolicyDecision = z
    .object({
      policyId: z.string(),
      policyVersion: z.string().optional(),
      verdict: z.enum(["allow", "deny", "pending"]),
      effects: z.array(PolicyEffect),
      obligations: z.array(PolicyObligation).optional(),
      reasonCodes: z.array(z.string()),
      factsUsed: z.array(z.string()).optional(),
      durationMs: z.number().min(0).optional(),
      priority: z.number().optional(),
    })
    .strict();
  export type PolicyDecision = z.infer<typeof PolicyDecision>;

  export const EffectiveDecision = z.object({
    verdict: z.enum(["allow", "deny", "pending"]),
    mergedEffects: z.array(PolicyEffect),
    obligations: z.array(PolicyObligation),
    contributingPolicies: z.array(z.string()),
  });
  export type EffectiveDecision = z.infer<typeof EffectiveDecision>;
}
