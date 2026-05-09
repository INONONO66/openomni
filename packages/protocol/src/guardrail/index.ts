import { z } from "zod";
import type { Hook } from "../hook/index";

export namespace Guardrail {
  export const PermissionDecision = z.enum(["allow", "deny", "require_approval"]);
  export type PermissionDecision = z.infer<typeof PermissionDecision>;

  export const InputRule = z.object({
    toolPattern: z.string(),
    field: z.string(),
    pattern: z.string().refine(
      (p) => {
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      },
      { message: "pattern must be a valid regular expression" },
    ),
    action: PermissionDecision,
    reason: z.string().optional(),
    priority: z.number().default(0),
  });
  export type InputRule = z.infer<typeof InputRule>;

  export const Permission = z.object({
    action: z.string(),
    allowlist: z.string().array().optional(),
    denylist: z.string().array().optional(),
    requireApproval: z.string().array().optional(),
    inputRules: InputRule.array().optional(),
  });
  export type Permission = z.infer<typeof Permission>;

  export const EvaluationRequest = z.object({
    action: z.string(),
    resource: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
    actor: z.record(z.string(), z.unknown()).optional(),
    resourceMeta: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  });
  export type EvaluationRequest = z.infer<typeof EvaluationRequest>;

  export const EvaluationResult = z.object({
    action: z.enum(["continue", "abort"]),
    decision: PermissionDecision.optional(),
    reason: z.string(),
    policyId: z.literal("guardrail.permission"),
    matchedPattern: z.string().optional(),
  });
  export type EvaluationResult = z.infer<typeof EvaluationResult> & Hook.Verdict;
}
