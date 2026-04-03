import { z } from "zod";

export namespace Guardrail {
  export const InputRule = z.object({
    toolPattern: z.string(),
    field: z.string(),
    pattern: z.string(),
    action: z.enum(["allow", "deny", "require_approval"]),
    reason: z.string().optional(),
    priority: z.number().default(0),
  });
  export type InputRule = z.infer<typeof InputRule>;

  export const ToolPermission = z.object({
    allowlist: z.string().array().optional(),
    denylist: z.string().array().optional(),
    requireApproval: z.string().array().optional(),
    inputRules: InputRule.array().optional(),
  });
  export type ToolPermission = z.infer<typeof ToolPermission>;

  export const GuardrailType = z.enum([
    "output_validation",
    "content_filter",
    "cost_limit",
    "custom",
  ]);
  export type GuardrailType = z.infer<typeof GuardrailType>;

  export const GuardrailSchema = z.object({
    type: GuardrailType,
    rule: z.string(),
    action: z.enum(["reject", "retry", "warn", "escalate"]),
  });
  export type GuardrailSchema = z.infer<typeof GuardrailSchema>;

  export const DelegationPolicy = z.object({
    maxDepth: z.number().default(3),
    budgetPolicy: z.enum(["inherit", "independent", "split"]),
    abortPropagation: z.boolean(),
    budgetAllocation: z.number().min(0).max(1).default(0.5),
    reserveForParent: z.number().min(0).max(1).default(0.2),
  });
  export type DelegationPolicy = z.infer<typeof DelegationPolicy>;
}
