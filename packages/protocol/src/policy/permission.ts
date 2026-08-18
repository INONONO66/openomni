import { z } from "zod";

export namespace PolicyPermission {
  const MAX_REGEX_PATTERN_LENGTH = 200;
  /** Evaluation-side input cap, shared with the evaluator in @openomni/policy. */
  export const MAX_INPUT_LENGTH = 10_000;

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

  /**
   * ReDoS-safety predicate for `InputRule.pattern`. Owned here because the
   * zod refine above validates at the schema boundary; the evaluation engine
   * (`evaluatePermission` in @openomni/policy) re-checks it at runtime.
   */
  export function isSafeInputPattern(pattern: string): boolean {
    return (
      pattern.length <= MAX_REGEX_PATTERN_LENGTH &&
      isRegexSyntaxValid(pattern) &&
      !hasUnsafeQuantifier(pattern)
    );
  }
}
