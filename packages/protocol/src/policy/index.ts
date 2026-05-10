import { z } from "zod";

export namespace Policy {
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
    policyId: z.string(),
    matchedPattern: z.string().optional(),
  });
  export type EvaluationResult = z.infer<typeof EvaluationResult>;

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
    z.object({
      action: z.literal("deny"),
      reason: z.string().optional(),
      policyId: z.string().optional(),
    }),
  ]);
  export type Verdict = z.infer<typeof Verdict>;

  export const Timing = {
    PRE_RUN: "pre_run",
    PRE_TURN: "pre_turn",
    ON_SYSTEM_PROMPT: "on_system_prompt",
    PRE_TOOL_USE: "pre_tool_use",
    POST_TOOL_USE: "post_tool_use",
    POST_TURN: "post_turn",
    POST_COMPACTION: "post_compaction",
    POST_RUN: "post_run",
    ON_ERROR: "on_error",
    PRE_INGRESS: "pre_ingress",
    POST_INGRESS: "post_ingress",
    PRE_DISPATCH: "pre_dispatch",
    POST_DISPATCH: "post_dispatch",
    PRE_TOOL_SELECTION: "pre_tool_selection",
    POST_TOOL_SELECTION: "post_tool_selection",
    PRE_DELEGATION: "pre_delegation",
    POST_DELEGATION: "post_delegation",
    PRE_MEMORY_ACCESS: "pre_memory_access",
    POST_MEMORY_ACCESS: "post_memory_access",
    PRE_ARTIFACT_WRITE: "pre_artifact_write",
    POST_ARTIFACT_WRITE: "post_artifact_write",
  } as const;

  export type Timing = (typeof Timing)[keyof typeof Timing];

  export const Scope = z.object({
    agentType: z.array(z.string()).optional(),
  });
  export type Scope = z.infer<typeof Scope>;

  export const FailPolicy = z.enum(["fail-open", "fail-closed"]);
  export type FailPolicy = z.infer<typeof FailPolicy>;

  export const Definition = z.object({
    name: z.string().min(1),
    timing: z.union([
      z.enum(Object.values(Timing) as [string, ...string[]]),
      z.array(z.enum(Object.values(Timing) as [string, ...string[]])),
    ]),
    priority: z.number().int().min(0),
    scope: Scope.optional(),
    failPolicy: FailPolicy.optional(),
  });
  export type Definition = z.infer<typeof Definition>;

  export const Decision = z.object({
    timing: z.string(),
    label: z.string(),
    policyId: z.string(),
    verdict: Verdict,
    reason: z.string().optional(),
    durationMs: z.number().optional(),
  });
  export type Decision = z.infer<typeof Decision>;
}
