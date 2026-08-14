import { Operational, Policy, PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/telemetry";
import type { CanonicalPolicyRegistration } from "../types";

const TOOL_CALL_ACTION = "tool.call";

export interface ToolPermissionPolicyConfig {
  permission: Policy.Permission;
}

/**
 * The trace this guard reports under. A permission evaluation happens inside
 * a tool call, which happens inside a run — the guard is never an origin.
 */
function requireGuardTraceId(ctx: {
  readonly traceContext?: { readonly traceId?: string };
}): string {
  const traceId = ctx.traceContext?.traceId;
  if (traceId === undefined || traceId.length === 0) {
    throw new Error("tool permission guard requires the run trace context");
  }
  return traceId;
}

export function createToolPermissionPolicy(
  config: ToolPermissionPolicyConfig,
): CanonicalPolicyRegistration {
  return {
    name: "builtin:tool-permission",
    kind: "point",
    pointIds: ["tool.native.pre", "tool.mcp.pre"],
    effectCapabilities: {
      "tool.native.pre": ["tool.require_approval", "run.abort", "audit.annotate"],
      "tool.mcp.pre": ["tool.require_approval", "run.abort", "audit.annotate"],
    },
    priority: 0,
    failPolicy: "fail-closed",
    fn: async (ctx) => {
      const toolName = ctx.toolName;
      const toolInput = ctx.toolInput;
      if (!toolName) return PolicyDecision.allow({ policyId: "guardrail.permission" });

      const normalizedPermission: Policy.Permission = config.permission.action
        ? config.permission
        : { ...config.permission, action: TOOL_CALL_ACTION };

      let verdict: Policy.EvaluationResult;
      try {
        verdict = Policy.evaluate(normalizedPermission, {
          action: TOOL_CALL_ACTION,
          resource: toolName,
          resourceLabels: ctx.toolLabels,
          input: toolInput ?? {},
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        Bus.publish(Operational.Debug, {
          traceId: requireGuardTraceId(ctx),
          time: Date.now(),
          component: "agent.policy.tool-permission",
          msg: "tool permission evaluation failed",
          context: { toolName, error: errorMessage },
        });
        return PolicyDecision.deny({
          policyId: "guardrail.permission",
          reasonCodes: ["tool_permission_evaluation_failed"],
          effects: [{ type: "run.abort", reason: "tool_permission_evaluation_failed" }],
        });
      }

      // The verdict carries the outcome: `require_approval` composes to a
      // `pending` decision, which `PolicyDecision.isBlocking` treats as
      // blocking, so the tool executor never runs the call.
      return PolicyDecision.fromEvaluation(verdict);
    },
  };
}
