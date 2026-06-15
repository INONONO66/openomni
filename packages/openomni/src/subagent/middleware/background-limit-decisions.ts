import { Policy, PolicyDecision, type RuntimeResource } from "@openomni/protocol";

export const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export function createBackgroundLaunchDescriptor(agentName: string): RuntimeResource.Descriptor {
  return {
    id: "worker:agent:background_launch",
    kind: "worker",
    source: { type: "agent", agentId: agentName },
    labels: ["source.agent", "delegation.background"],
    capabilities: ["delegation.background"],
    effects: ["session.create"],
  };
}

export function allowDecision(policyId: string, reason: string): Policy.PolicyDecision {
  return PolicyDecision.allow({ policyId, reasonCodes: [reason] });
}

export function evaluateLimit(input: {
  readonly action: string;
  readonly resource: string;
  readonly field: string;
  readonly allowed: boolean;
  readonly allowReason: string;
  readonly denyReason: string;
  readonly metadata?: Record<string, unknown>;
}): Policy.PolicyDecision {
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
      {
        action: input.action,
        resource: input.resource,
        input: { [input.field]: String(input.allowed) },
        metadata: input.metadata,
      },
    ),
    { denyEffect: { type: "run.abort", reason: input.denyReason } },
  );
}
