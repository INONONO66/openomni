import { z } from "zod";

export namespace PolicyPermission {
  const MAX_REGEX_PATTERN_LENGTH = 200;
  const MAX_INPUT_LENGTH = 10_000;
  const POLICY_ID = "guardrail.permission";

  // Label source enumeration: where a label originates from
  // Labels use source.category naming convention to prevent namespace collisions
  // Examples: tool.filesystem, actor.owner, surface.github, risk.tier-2, capability.write
  const Label = {
    Source: z.enum(["system", "tool_metadata", "agent_profile", "policy_rule", "operator"]),
  } as const;

  // Label entry: a labeled value with its source for audit and policy evaluation
  export const LabelEntry = z.object({
    value: z.string(),
    source: Label.Source,
  });
  export type LabelEntry = z.infer<typeof LabelEntry>;

  const PermissionDecision = z.enum(["allow", "deny", "require_approval"]);
  type PermissionDecision = z.infer<typeof PermissionDecision>;

  export const InputRule = z.object({
    toolPattern: z.string(),
    field: z.string(),
    pattern: z.string().refine(isSafeInputPattern, {
      message: "pattern must be a safe valid regular expression",
    }),
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

  function isRegexSyntaxValid(pattern: string): boolean {
    try {
      new RegExp(pattern);
      return true;
    } catch {
      return false;
    }
  }

  function stripEscapesAndCharacterClasses(pattern: string): string {
    let normalized = "";
    let inClass = false;

    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index];

      if (char === "\\") {
        index += 1;
        normalized += "x";
        continue;
      }

      if (char === "[" && !inClass) {
        inClass = true;
        normalized += "x";
        continue;
      }

      if (char === "]" && inClass) {
        inClass = false;
        continue;
      }

      if (!inClass) normalized += char;
    }

    return normalized;
  }

  function hasUnsafeQuantifier(pattern: string): boolean {
    const normalized = stripEscapesAndCharacterClasses(pattern);
    const quantifier = String.raw`(?:[+*?]|\{[0-9,]+\})`;
    const adjacentQuantifiedAtoms = new RegExp(String.raw`(?:[\w.]${quantifier}){2,}`);
    const quantifiedAtom = new RegExp(String.raw`[\w.]${quantifier}`, "g");
    const quantifiedAtomInGroup = new RegExp(String.raw`\([^)]*[\w.]${quantifier}[^)]*\)`);
    const quantifiedGroup = new RegExp(String.raw`\)${quantifier}`);
    const backreference = /\\[1-9]/;
    const quantifiedAtomCount = normalized.match(quantifiedAtom)?.length ?? 0;

    return (
      adjacentQuantifiedAtoms.test(normalized) ||
      quantifiedAtomCount > 1 ||
      quantifiedAtomInGroup.test(normalized) ||
      quantifiedGroup.test(normalized) ||
      backreference.test(pattern)
    );
  }

  function isSafeInputPattern(pattern: string): boolean {
    return (
      pattern.length <= MAX_REGEX_PATTERN_LENGTH &&
      isRegexSyntaxValid(pattern) &&
      !hasUnsafeQuantifier(pattern)
    );
  }

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

  type InputMatchResult = "match" | "miss" | "unsafe";

  function matchesInputField(
    input: Record<string, unknown> | undefined,
    field: string,
    pattern: string,
  ): InputMatchResult {
    if (!isSafeInputPattern(pattern)) return "unsafe";

    const raw = String(input?.[field] ?? "");
    const value = raw.length > MAX_INPUT_LENGTH ? raw.slice(0, MAX_INPUT_LENGTH) : raw;

    return new RegExp(pattern).test(value) ? "match" : "miss";
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
      if (!matchesPattern(request.resource, rule.toolPattern)) continue;

      const inputMatch = matchesInputField(request.input, rule.field, rule.pattern);
      if (inputMatch === "unsafe") {
        return verdict("deny", "unsafe_input_rule", rule.toolPattern);
      }
      if (inputMatch === "match") {
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
}
