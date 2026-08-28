import { type Policy, PolicyDecision, PolicyPermission } from "@openomni/protocol";

/**
 * The permission evaluation engine, moved from protocol to its owner (#498 W1).
 * Protocol keeps the vocabulary (Permission/EvaluationRequest/EvaluationResult
 * schemas and the ReDoS-safety predicate that `InputRule.pattern` refines on);
 * this module owns the behavior.
 */

const POLICY_ID = "guardrail.permission";

type PermissionDecision = NonNullable<Policy.EvaluationResult["decision"]>;

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
  if (!PolicyPermission.isSafeInputPattern(pattern)) return "unsafe";

  const raw = String(input?.[field] ?? "");
  const value =
    raw.length > PolicyPermission.MAX_INPUT_LENGTH
      ? raw.slice(0, PolicyPermission.MAX_INPUT_LENGTH)
      : raw;

  return new RegExp(pattern).test(value) ? "match" : "miss";
}

function verdict(
  decision: PermissionDecision,
  reason: string,
  matchedPattern?: string,
): Policy.EvaluationResult {
  const action: Policy.EvaluationResult["action"] = decision === "allow" ? "continue" : "abort";
  return matchedPattern === undefined
    ? { action, decision, reason, policyId: POLICY_ID }
    : { action, decision, reason, policyId: POLICY_ID, matchedPattern };
}

export function evaluatePermission(
  permission: Policy.Permission | undefined,
  request: Policy.EvaluationRequest,
): Policy.EvaluationResult {
  if (!permission) return verdict("deny", `default_deny:${request.action}`);
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

  return verdict("deny", `default_deny:${request.action}`);
}

export function decisionFromEvaluation(
  result: Policy.EvaluationResult,
  options: {
    readonly policyId?: string;
    readonly denyEffect?: Policy.PolicyEffect;
  } = {},
): Policy.PolicyDecision {
  const policyId = options.policyId ?? result.policyId;
  const reasonCodes = [result.reason];
  if (result.decision === "require_approval") {
    return PolicyDecision.pending({
      policyId,
      reasonCodes,
      effects: [{ type: "tool.require_approval", reason: result.reason }],
      obligations: [
        {
          obligationId: `${policyId}.approval`,
          type: "humanApproval",
          description: result.reason,
        },
      ],
    });
  }

  if (result.action === "continue") return PolicyDecision.allow({ policyId, reasonCodes });

  return PolicyDecision.deny({
    policyId,
    reasonCodes,
    effects: [
      options.denyEffect ?? { type: "run.abort", reason: result.reason },
      { type: "audit.annotate", annotation: result.reason, severity: "error" },
    ],
  });
}
