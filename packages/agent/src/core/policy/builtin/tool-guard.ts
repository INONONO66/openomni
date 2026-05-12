import { Operational, Policy } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AgentEventEmitter } from "../../types";
import type { PolicyFactory, PolicyRegistration } from "../types";
import { summarizeInput } from "../../execution/shared";

const TOOL_CALL_ACTION = "tool.call";

export interface ToolPermissionPolicyConfig {
  permission: Policy.Permission;
  eventEmitter?: AgentEventEmitter;
  source?: string;
  onToolBlocked?: (toolCallId: string, toolName: string, reason: string) => void;
}

export function createToolPermissionPolicy(config: ToolPermissionPolicyConfig): PolicyRegistration {
  return {
    name: "builtin:tool-permission",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
    fn: async (ctx) => {
      const toolName = ctx.toolName;
      const toolInput = ctx.toolInput;
      if (!toolName) return { action: "continue" };

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
        Bus.publish(Operational.Debug, {
          traceId: crypto.randomUUID(),
          time: Date.now(),
          component: "agent.policy.tool-permission",
          msg: "tool permission evaluation failed",
          context: { toolName, error: String(error) },
        });
        return {
          action: "abort",
          reason: "tool_permission_evaluation_failed",
          policyId: "guardrail.permission",
        };
      }

      if (verdict.action === "continue") {
        config.eventEmitter?.emit("tool.execution.started", {
          sessionId: config.source,
          time: Date.now(),
          toolCallId: ctx.toolCallId,
          toolName,
          inputSummary: summarizeInput(toolInput ?? {}),
        });
        return verdict;
      }

      config.eventEmitter?.emit("tool.execution.permission_denied", {
        sessionId: config.source,
        time: Date.now(),
        toolCallId: ctx.toolCallId,
        toolName,
        reason: verdict.reason,
      });
      config.onToolBlocked?.(ctx.toolCallId ?? "", toolName, verdict.reason);
      return verdict;
    },
  };
}

export const toolPermissionFactory: PolicyFactory = {
  id: "policy:tool-permission",
  create: (config) => createToolPermissionPolicy(config as ToolPermissionPolicyConfig),
};
