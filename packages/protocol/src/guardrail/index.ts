import { z } from "zod";
import type { Hook } from "../hook/index";

export namespace Guardrail {
  const MAX_REGEX_PATTERN_LENGTH = 200;
  const MAX_INPUT_LENGTH = 10_000;
  const POLICY_ID = "guardrail.permission";

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
    policyId: z.literal(POLICY_ID),
    matchedPattern: z.string().optional(),
  });
  export type EvaluationResult = z.infer<typeof EvaluationResult> & Hook.Verdict;

  function matchesPattern(resource: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) return resource.startsWith(`${pattern.slice(0, -2)}.`);
    return resource === pattern;
  }

  function matchesInputField(
    input: Record<string, unknown> | undefined,
    field: string,
    pattern: string,
  ): boolean {
    if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;

    const raw = String(input?.[field] ?? "");
    const value = raw.length > MAX_INPUT_LENGTH ? raw.slice(0, MAX_INPUT_LENGTH) : raw;

    try {
      return new RegExp(pattern).test(value);
    } catch {
      return false;
    }
  }

  function verdict(
    decision: PermissionDecision,
    reason: string,
    matchedPattern?: string,
  ): EvaluationResult {
    const action: Extract<Hook.Verdict["action"], "continue" | "abort"> =
      decision === "allow" ? "continue" : "abort";
    return matchedPattern === undefined
      ? { action, decision, reason, policyId: POLICY_ID }
      : { action, decision, reason, policyId: POLICY_ID, matchedPattern };
  }

  export function evaluate(
    permission: Permission | undefined,
    request: EvaluationRequest,
  ): EvaluationResult {
    if (!permission) return verdict("allow", "default_allow");
    if (permission.action !== request.action) return verdict("deny", "action_mismatch");

    const inputRules = [...(permission.inputRules ?? [])].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );

    for (const rule of inputRules) {
      if (
        matchesPattern(request.resource, rule.toolPattern) &&
        matchesInputField(request.input, rule.field, rule.pattern)
      ) {
        return verdict(rule.action, rule.reason ?? `input_rule_${rule.action}`, rule.toolPattern);
      }
    }

    const deniedBy = permission.denylist?.find((pattern) =>
      matchesPattern(request.resource, pattern),
    );
    if (deniedBy) return verdict("deny", "denylist", deniedBy);

    const requiresApprovalBy = permission.requireApproval?.find((pattern) =>
      matchesPattern(request.resource, pattern),
    );
    if (requiresApprovalBy) {
      return verdict("require_approval", "require_approval", requiresApprovalBy);
    }

    if (permission.allowlist !== undefined) {
      const allowedBy = permission.allowlist.find((pattern) =>
        matchesPattern(request.resource, pattern),
      );

      if (allowedBy) return verdict("allow", "allowlist", allowedBy);

      return verdict(
        "deny",
        permission.allowlist.length === 0 ? "allowlist_empty" : "allowlist_miss",
      );
    }

    return verdict("allow", "default_allow");
  }

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
    abortPropagation: z.boolean(),
  });
  export type DelegationPolicy = z.infer<typeof DelegationPolicy>;
}
