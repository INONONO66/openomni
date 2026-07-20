import { Operational, Policy, PolicyDecision } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AgentEventEmitter } from "../../types";
import type { CanonicalPolicyRegistration } from "../types";
import { summarizeInput } from "../../execution/shared";

const TOOL_CALL_ACTION = "tool.call";

export interface ToolPermissionPolicyConfig {
  permission: Policy.Permission;
  eventEmitter?: AgentEventEmitter;
  source?: string;
  onToolBlocked?: (toolCallId: string, toolName: string, reason: string) => void;
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
          traceId: crypto.randomUUID(),
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

      if (verdict.action === "continue") {
        config.eventEmitter?.emit("tool.execution.started", {
          sessionId: config.source,
          time: Date.now(),
          toolCallId: ctx.toolCallId,
          toolName,
          inputSummary: summarizeInput(toolInput ?? {}),
        });
        return PolicyDecision.fromEvaluation(verdict);
      }

      config.eventEmitter?.emit("tool.execution.permission_denied", {
        sessionId: config.source,
        time: Date.now(),
        toolCallId: ctx.toolCallId,
        toolName,
        reason: verdict.reason,
      });
      config.onToolBlocked?.(ctx.toolCallId ?? "", toolName, verdict.reason);
      return PolicyDecision.fromEvaluation(verdict);
    },
  };
}
