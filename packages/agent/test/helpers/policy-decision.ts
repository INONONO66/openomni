import { PolicyDecision, type Policy, type Message } from "@openomni/protocol";

export function allow(
  policyId = "test.allow",
  reason?: string,
  effects: Policy.PolicyEffect[] = [],
): Policy.PolicyDecision {
  return PolicyDecision.allow({ policyId, ...(reason ? { reasonCodes: [reason] } : {}), effects });
}

export function effectOf<TType extends Policy.PolicyEffect["type"]>(
  decision: Policy.PolicyDecision,
  type: TType,
): Extract<Policy.PolicyEffect, { type: TType }> | undefined {
  return decision.effects.find(
    (effect): effect is Extract<Policy.PolicyEffect, { type: TType }> => effect.type === type,
  );
}

export function deny(
  policyId = "test.deny",
  reason = "blocked",
  effects?: Policy.PolicyEffect[],
): Policy.PolicyDecision {
  return PolicyDecision.deny({
    policyId,
    reasonCodes: [reason],
    effects: effects ?? [{ type: "audit.annotate", annotation: reason, severity: "error" }],
  });
}

export function abortRun(policyId = "test.abort", reason = "blocked"): Policy.PolicyDecision {
  return deny(policyId, reason, [{ type: "run.abort", reason }]);
}

export function pending(
  policyId = "test.pending",
  reason = "pending",
  effects: Policy.PolicyEffect[] = [],
): Policy.PolicyDecision {
  return PolicyDecision.pending({ policyId, reasonCodes: [reason], effects });
}

export function inject(
  message: string,
  policyId = "test.inject",
  reason = "inject",
): Policy.PolicyDecision {
  return allow(policyId, reason, [{ type: "prompt.inject_message", message }]);
}

export function appendContext(
  context: string,
  policyId = "test.context",
  reason = "append_context",
): Policy.PolicyDecision {
  return allow(policyId, reason, [{ type: "prompt.append_context", context }]);
}

export function replacePrompt(
  prompt: string,
  policyId = "test.prompt",
  reason = "replace_prompt",
): Policy.PolicyDecision {
  return allow(policyId, reason, [{ type: "prompt.replace", prompt }]);
}

export function continueWithPrompt(
  prompt: string,
  policyId = "test.continue",
  reason = "continue_with_prompt",
): Policy.PolicyDecision {
  return allow(policyId, reason, [{ type: "run.continue_with_prompt", prompt }]);
}

export function filterTools(
  toolPatterns: string[],
  policyId = "test.filter",
  reason = "filter_tools",
): Policy.PolicyDecision {
  return allow(
    policyId,
    reason,
    toolPatterns.map((toolPattern) => ({ type: "tool.filter", toolPattern })),
  );
}

export function rewriteToolInput(
  input: Record<string, unknown>,
  policyId = "test.rewrite-input",
  reason = "rewrite_input",
): Policy.PolicyDecision {
  return allow(policyId, reason, [{ type: "tool.rewrite_input", input }]);
}

export function rewriteToolOutput(
  output: string,
  policyId = "test.rewrite-output",
  reason = "rewrite_output",
): Policy.PolicyDecision {
  return allow(policyId, reason, [{ type: "tool.rewrite_output", output }]);
}

export function replaceMessages(
  messages: Message.WithParts[],
  policyId = "test.replace-messages",
  reason = "replace_messages",
): Policy.PolicyDecision {
  return allow(policyId, reason, [{ type: "run.replace_messages", messages }]);
}
