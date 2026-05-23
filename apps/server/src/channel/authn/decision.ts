import { Policy, PolicyDecision } from "@openomni/protocol";
import { authTiming } from "./definitions";
import type { ChannelAuthnDecisionObserver, ChannelAuthnPolicyId } from "./types";

export function evaluateChannelPermission(input: {
  readonly action: ChannelAuthnPolicyId;
  readonly resource: string;
  readonly field: string;
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
  readonly metadata?: Record<string, unknown>;
}): Policy.PolicyDecision {
  const request: Policy.EvaluationRequest = {
    action: input.action,
    resource: input.resource,
    input: { [input.field]: String(input.allowed) },
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };

  return PolicyDecision.fromEvaluation(
    Policy.evaluate(
      {
        action: input.action,
        inputRules: [
          {
            toolPattern: input.resource,
            field: input.field,
            pattern: "^true$",
            action: "allow",
            reason: input.allowReason,
            priority: 2,
          },
          {
            toolPattern: input.resource,
            field: input.field,
            pattern: "^false$",
            action: "deny",
            reason: input.denyReason,
            priority: 1,
          },
        ],
      },
      request,
    ),
    { denyEffect: { type: "run.abort", reason: input.denyReason } },
  );
}

export function recordDecision(
  definition: Policy.Definition,
  verdict: Policy.PolicyDecision,
  durationMs: number,
  onDecision: ChannelAuthnDecisionObserver | undefined,
  metadata?: Record<string, unknown>,
): void | Promise<void> {
  return onDecision?.({
    timing: authTiming,
    name: definition.name,
    policyId: verdict.policyId ?? "guardrail.permission",
    verdict: verdict.verdict,
    reason: PolicyDecision.reason(verdict, "unspecified"),
    durationMs,
    ...(metadata !== undefined ? { metadata } : {}),
  });
}
