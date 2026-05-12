import { z } from "zod";

export namespace Policy {
  const MAX_REGEX_PATTERN_LENGTH = 200;
  const MAX_INPUT_LENGTH = 10_000;
  const POLICY_ID = "guardrail.permission";

  // Label source enumeration: where a label originates from
  // Labels use source.category naming convention to prevent namespace collisions
  // Examples: tool.filesystem, actor.owner, surface.github, risk.tier-2, capability.write
  export const Label = {
    Source: z.enum(["system", "tool_metadata", "agent_profile", "policy_rule", "operator"]),
  } as const;

  export type Label = {
    Source: z.infer<typeof Label.Source>;
  };

  // Label entry: a labeled value with its source for audit and policy evaluation
  export const LabelEntry = z.object({
    value: z.string(),
    source: Label.Source,
  });
  export type LabelEntry = z.infer<typeof LabelEntry>;

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
    allowLabels: z.string().array().optional(),
    denyLabels: z.string().array().optional(),
    requireApprovalLabels: z.string().array().optional(),
    inputRules: InputRule.array().optional(),
  });
  export type Permission = z.infer<typeof Permission>;

  export const EvaluationRequest = z.object({
    action: z.string(),
    resource: z.string(),
    resourceLabels: z.array(z.string()).optional(),
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

  function matchesPattern(resource: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith(".*")) return resource.startsWith(`${pattern.slice(0, -2)}.`);
    return resource === pattern;
  }

  function findMatchingLabel(
    labels: readonly string[] | undefined,
    patterns: readonly string[] | undefined,
  ): string | undefined {
    if (!patterns || patterns.length === 0) return undefined;
    for (const pattern of patterns) {
      if (labels?.some((label) => matchesPattern(label, pattern))) return pattern;
    }
    return undefined;
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
    const action: EvaluationResult["action"] = decision === "allow" ? "continue" : "abort";
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

    const deniedByLabel = findMatchingLabel(request.resourceLabels, permission.denyLabels);
    if (deniedByLabel) return verdict("deny", "deny_label", deniedByLabel);

    const requiresApprovalBy = permission.requireApproval?.find((pattern) =>
      matchesPattern(request.resource, pattern),
    );
    if (requiresApprovalBy) {
      return verdict("require_approval", "require_approval", requiresApprovalBy);
    }

    const requiresApprovalByLabel = findMatchingLabel(
      request.resourceLabels,
      permission.requireApprovalLabels,
    );
    if (requiresApprovalByLabel) {
      return verdict("require_approval", "require_approval_label", requiresApprovalByLabel);
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

    if (permission.allowLabels !== undefined) {
      const allowedByLabel = findMatchingLabel(request.resourceLabels, permission.allowLabels);
      if (allowedByLabel) return verdict("allow", "allow_label", allowedByLabel);
      return verdict(
        "deny",
        permission.allowLabels.length === 0 ? "allow_labels_empty" : "allow_labels_miss",
      );
    }

    return verdict("allow", "default_allow");
  }

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
    PRE_TOOL_SELECTION: "pre_tool_selection",
    PRE_DELEGATION: "pre_delegation",
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
      type: z.literal("tool.filter"),
      toolPattern: z.string(),
    }),
    z.object({
      type: z.literal("tool.rewrite_input"),
      input: z.record(z.string(), z.unknown()),
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
  ]);
  export type PolicyEffect = z.infer<typeof PolicyEffect>;

  export const PolicyPoint = z.object({
    point: z.enum(Object.values(Timing) as [string, ...string[]]),
    allowedEffects: z.array(
      z.enum([
        "prompt.append_context",
        "prompt.inject_message",
        "tool.filter",
        "tool.rewrite_input",
        "tool.require_approval",
        "run.abort",
        "run.continue_with_prompt",
        "run.retry_after",
        "delegation.set_constraints",
        "delegation.require_approval",
        "audit.annotate",
      ] as const),
    ),
    defaultFailPolicy: FailPolicy,
  });
  export type PolicyPoint = z.infer<typeof PolicyPoint>;

  export const PolicyPlan = z.object({
    policies: z.array(
      z.object({
        id: z.string().min(1),
        required: z.boolean(),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    labels: z.array(z.string()),
    registryVersion: z.string().optional(),
  });
  export type PolicyPlan = z.infer<typeof PolicyPlan>;
}

export namespace RuntimeResource {
  export const Descriptor = z.object({
    id: z.string(),
    kind: z.union([z.enum(["tool", "skill", "mcpSource", "policy"]), z.string()]),
    version: z.string().optional(),
    labels: z.array(z.string()),
    capabilities: z.array(z.string()),
    effects: z.array(z.string()),
    risk: z.number().optional(),
    source: z
      .object({
        type: z.string(),
        serverId: z.string().optional(),
        remoteName: z.string().optional(),
      })
      .optional(),
    schemaRef: z.string().optional(),
    digest: z.string().optional(),
    owner: z.string().optional(),
  });
  export type Descriptor = z.infer<typeof Descriptor>;
}
