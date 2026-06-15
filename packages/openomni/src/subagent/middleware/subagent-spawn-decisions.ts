import type { PolicyRegistration } from "@openomni/agent";
import { Policy, PolicyDecision, type RuntimeResource } from "@openomni/protocol";
import * as Definitions from "./subagent-spawn-definitions.js";
import type { PreSpawnOperation } from "./subagent-spawn-types.js";

export const emptyUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
export const defaultCancelHardTimeoutMs = 10_000;

export function createSubagentOperationDescriptor(
  operation: PreSpawnOperation,
): RuntimeResource.Descriptor {
  return {
    id: `worker:subagent:${operation}`,
    kind: "worker",
    source: { type: "agent" },
    labels: ["source.agent", "delegation.subagent", `operation.${operation}`],
    capabilities: [`delegation.${operation}`],
    effects: operation === "wait" ? [] : ["session.message"],
  };
}

export function allowDecision(policyId: string, reason: string): Policy.PolicyDecision {
  return PolicyDecision.allow({ policyId, reasonCodes: [reason] });
}

export function evaluateBooleanPolicy(input: {
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

export function createDefaultDenylist(): PolicyRegistration {
  return {
    ...Definitions.DefaultDenylist,
    failPolicy: "fail-closed",
    fn: (ctx) => {
      const toolName = ctx.toolName ?? "";
      return PolicyDecision.fromEvaluation(
        Policy.evaluate(
          { action: "tool.call", denylist: ["subagent"] },
          { action: "tool.call", resource: toolName },
        ),
        { denyEffect: { type: "run.abort", reason: "subagent tool denied by default" } },
      );
    },
  };
}
