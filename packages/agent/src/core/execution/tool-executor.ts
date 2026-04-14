import type { Guardrail, Tool } from "@openomni/protocol";
import type {
  AgentEventEmitter,
  ChatAgentConfig,
  AgentStep,
  ExecutionHooks,
  HookContext,
  HookVerdict,
} from "../types";
import { ToolGuard } from "../tool-guard";
import { summarizeInput } from "./shared";

export interface ToolExecutorOptions {
  toolExecutor: (call: Tool.Call) => Promise<Tool.Result>;
  permission?: Guardrail.ToolPermission;
  hooks?: ExecutionHooks;
  stepGuard?: ChatAgentConfig["stepGuard"];
  eventEmitter?: AgentEventEmitter;
  onVerdict?: (verdict: HookVerdict) => void;
  getContext?: () => Omit<HookContext, "toolName" | "toolCallId" | "input">;
  source?: string;
}

/**
 * Creates a unified tool executor that applies guard checks and hooks in sequence.
 * Combines guard logic (ToolGuard + stepGuard) with hook logic (preToolUse).
 */
export function createToolExecutor(
  options: ToolExecutorOptions,
): (call: Tool.Call) => Promise<Tool.Result> {
  const {
    toolExecutor,
    permission,
    hooks,
    stepGuard,
    eventEmitter,
    onVerdict,
    getContext,
    source = "agent",
  } = options;

  const guardedExecutor = permission
    ? createGuardedLayer(toolExecutor, permission, eventEmitter, stepGuard, source)
    : toolExecutor;

  const hookedExecutor = hooks?.preToolUse
    ? createHookedLayer(guardedExecutor, hooks, getContext, onVerdict)
    : guardedExecutor;

  return hookedExecutor;
}

function createGuardedLayer(
  toolExecutor: (call: Tool.Call) => Promise<Tool.Result>,
  permission: Guardrail.ToolPermission,
  eventEmitter?: AgentEventEmitter,
  stepGuard?: ChatAgentConfig["stepGuard"],
  source?: string,
): (call: Tool.Call) => Promise<Tool.Result> {
  return async (call: Tool.Call): Promise<Tool.Result> => {
    let verdict: "allow" | "deny" | "require_approval";
    try {
      verdict = ToolGuard.check(call.tool, call.input, permission);
    } catch {
      verdict = "deny";
    }

    if (verdict === "deny") {
      eventEmitter?.emit("agent.tool.blocked", {
        sessionId: source,
        time: Date.now(),
        toolCallId: call.id,
        toolName: call.tool,
        reason: "denied by policy",
      });
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Blocked: Tool "${call.tool}" is not permitted by policy]`,
        isError: true,
      };
    }

    if (verdict === "require_approval") {
      if (stepGuard) {
        const syntheticStep: AgentStep = {
          type: "tool-call",
          content: `Tool "${call.tool}" requires approval`,
          toolCalls: [call],
        };
        const guardContext = {
          steps: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          turnCount: 0,
          isCompletion: false,
          continuationCount: 0,
          elapsedMs: 0,
        };
        try {
          const guardVerdict = await stepGuard(syntheticStep, guardContext);
          if (guardVerdict.action === "continue") {
            eventEmitter?.emit("agent.tool.invoked", {
              sessionId: source,
              time: Date.now(),
              toolCallId: call.id,
              toolName: call.tool,
              inputSummary: summarizeInput(call.input),
            });
            return toolExecutor(call);
          }
        } catch {
          // stepGuard threw; treat as denial
        }
      }

      eventEmitter?.emit("agent.tool.blocked", {
        sessionId: source,
        time: Date.now(),
        toolCallId: call.id,
        toolName: call.tool,
        reason: "requires approval",
      });
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Blocked: Tool "${call.tool}" requires approval]`,
        isError: true,
      };
    }

    eventEmitter?.emit("agent.tool.invoked", {
      sessionId: source,
      time: Date.now(),
      toolCallId: call.id,
      toolName: call.tool,
      inputSummary: summarizeInput(call.input),
    });
    return toolExecutor(call);
  };
}

function createHookedLayer(
  toolExecutor: (call: Tool.Call) => Promise<Tool.Result>,
  hooks: ExecutionHooks,
  getContext?: () => Omit<HookContext, "toolName" | "toolCallId" | "input">,
  onVerdict?: (verdict: HookVerdict) => void,
): (call: Tool.Call) => Promise<Tool.Result> {
  if (!hooks.preToolUse) return toolExecutor;

  const preToolUse = hooks.preToolUse;

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const context: HookContext = {
      ...(getContext?.() ?? {}),
      toolName: call.tool,
      toolCallId: call.id,
      input: call.input,
    } as HookContext;

    let verdict: HookVerdict;
    try {
      verdict = await preToolUse(context);
    } catch (err) {
      console.warn("[hooks.preToolUse] threw, treating as continue:", err);
      verdict = { action: "continue" };
    }

    onVerdict?.(verdict);

    if (verdict.action === "skip") {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Skipped: ${verdict.reason ?? "hook"}]`,
        isError: false,
      };
    }

    if (verdict.action === "abort") {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Aborted: ${verdict.reason ?? "hook"}]`,
        isError: true,
      };
    }

    if (verdict.action === "transform") {
      const transformed: Tool.Call = { ...call, input: verdict.input };
      return toolExecutor(transformed);
    }

    if (verdict.action === "retry" || verdict.action === "inject") {
      console.warn(
        `[hooks.preToolUse] "${verdict.action}" not supported for preToolUse, treating as continue`,
      );
    }

    return toolExecutor(call);
  };
}
