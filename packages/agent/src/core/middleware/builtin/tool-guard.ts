import type { Guardrail } from "@openomni/protocol";
import type { AgentEventEmitter, ChatAgentConfig } from "../../types";
import type { MiddlewareRegistration } from "../types";
import { ToolGuard } from "../../tool-guard";
import { summarizeInput } from "../../execution/shared";

export interface ToolGuardMiddlewareConfig {
  permission: Guardrail.ToolPermission;
  stepGuard?: ChatAgentConfig["stepGuard"];
  eventEmitter?: AgentEventEmitter;
  source?: string;
}

export function createToolGuardMiddleware(
  config: ToolGuardMiddlewareConfig,
): MiddlewareRegistration {
  return {
    name: "builtin:tool-guard",
    timing: "pre_tool_use",
    priority: 0,
    failPolicy: "fail-closed",
    fn: async (ctx) => {
      const toolName = ctx.toolName;
      const toolInput = ctx.toolInput;
      if (!toolName) return { action: "continue" };

      let verdict: "allow" | "deny" | "require_approval";
      try {
        verdict = ToolGuard.check(toolName, toolInput ?? {}, config.permission);
      } catch {
        verdict = "deny";
      }

      if (verdict === "deny") {
        config.eventEmitter?.emit("agent.tool.blocked", {
          sessionId: config.source,
          time: Date.now(),
          toolCallId: ctx.toolCallId,
          toolName,
          reason: "denied by policy",
        });
        return {
          action: "abort",
          reason: `Blocked: Tool "${toolName}" is not permitted by policy`,
        };
      }

      if (verdict === "require_approval") {
        if (config.stepGuard) {
          const input = toolInput ?? {};
          const syntheticStep = {
            type: "tool-call" as const,
            content: `Tool "${toolName}" requires approval`,
            toolCalls: [{ id: ctx.toolCallId ?? "", tool: toolName, input }],
          };
          const guardContext = {
            steps: ctx.steps,
            usage: ctx.usage,
            turnCount: ctx.turnCount,
            isCompletion: false,
            continuationCount: 0,
            elapsedMs: ctx.elapsedMs,
          };
          try {
            const guardVerdict = await config.stepGuard(syntheticStep, guardContext);
            if (guardVerdict.action === "continue") {
              config.eventEmitter?.emit("agent.tool.invoked", {
                sessionId: config.source,
                time: Date.now(),
                toolCallId: ctx.toolCallId,
                toolName,
                inputSummary: summarizeInput(input),
              });
              return { action: "continue" };
            }
          } catch {
            // stepGuard threw; treat as denial
          }
        }

        config.eventEmitter?.emit("agent.tool.blocked", {
          sessionId: config.source,
          time: Date.now(),
          toolCallId: ctx.toolCallId,
          toolName,
          reason: "requires approval",
        });
        return {
          action: "abort",
          reason: `Blocked: Tool "${toolName}" requires approval`,
        };
      }

      config.eventEmitter?.emit("agent.tool.invoked", {
        sessionId: config.source,
        time: Date.now(),
        toolCallId: ctx.toolCallId,
        toolName,
        inputSummary: summarizeInput(toolInput ?? {}),
      });
      return { action: "continue" };
    },
  };
}
