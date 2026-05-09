import type { Guardrail } from "@openomni/protocol";
import type { AgentEventEmitter, AgentStep, StepGuardContext, StepGuardVerdict } from "../../types";
import type { PolicyRegistration } from "../types";
import { Log } from "@openomni/session";
import { ToolGuard } from "../../tool-guard";
import { summarizeInput } from "../../execution/shared";

export interface ToolGuardMiddlewareConfig {
  permission: Guardrail.Permission;
  stepGuard?: (
    step: AgentStep,
    context: StepGuardContext,
  ) => Promise<StepGuardVerdict> | StepGuardVerdict;
  eventEmitter?: AgentEventEmitter;
  source?: string;
  onToolBlocked?: (toolCallId: string, toolName: string, reason: string) => void;
}

export function createToolGuardMiddleware(config: ToolGuardMiddlewareConfig): PolicyRegistration {
  return {
    name: "builtin:tool-guard",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
    fn: async (ctx) => {
      const toolName = ctx.toolName;
      const toolInput = ctx.toolInput;
      if (!toolName) return { action: "continue" };

      let verdict: Guardrail.EvaluationResult;
      try {
        verdict = ToolGuard.evaluate(toolName, toolInput ?? {}, config.permission);
      } catch (error) {
        Log.debug("tool guard evaluation failed", { toolName, error });
        return {
          action: "abort",
          reason: "tool_guard_evaluation_failed",
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

      if (verdict.decision !== "require_approval") {
        config.eventEmitter?.emit("tool.execution.permission_denied", {
          sessionId: config.source,
          time: Date.now(),
          toolCallId: ctx.toolCallId,
          toolName,
          reason: verdict.reason,
        });
        config.onToolBlocked?.(ctx.toolCallId ?? "", toolName, verdict.reason);
        return verdict;
      }

      if (config.stepGuard) {
        const input = toolInput ?? {};
        const syntheticStep = {
          type: "tool-call" as const,
          content: `Tool "${toolName}" requires approval`,
          toolCalls: [{ id: ctx.toolCallId ?? "", tool: toolName, input }],
        };
        const guardContext: StepGuardContext = {
          steps: ctx.steps ?? [],
          usage: ctx.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          turnCount: ctx.turnCount ?? 0,
          isCompletion: false,
          continuationCount: 0,
          elapsedMs: ctx.elapsedMs ?? 0,
        };
        try {
          const guardVerdict = await config.stepGuard(syntheticStep, guardContext);
          if (guardVerdict.action === "continue") {
            config.eventEmitter?.emit("tool.execution.started", {
              sessionId: config.source,
              time: Date.now(),
              toolCallId: ctx.toolCallId,
              toolName,
              inputSummary: summarizeInput(input),
            });
            return { action: "continue", reason: verdict.reason, policyId: verdict.policyId };
          }
        } catch (error) {
          Log.debug("tool guard evaluation failed", { toolName, error });
        }
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
