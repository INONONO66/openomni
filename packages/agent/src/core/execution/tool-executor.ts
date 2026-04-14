import type { Tool } from "@openomni/protocol";
import type { HookContext, HookVerdict } from "../types";
import type { MiddlewareEngineInstance } from "../middleware";

export interface ToolExecutorOptions {
  toolExecutor: (call: Tool.Call) => Promise<Tool.Result>;
  engine: MiddlewareEngineInstance;
  getContext?: () => Omit<HookContext, "toolName" | "toolCallId" | "input">;
  onVerdict?: (verdict: HookVerdict) => void;
}

export function createToolExecutor(
  options: ToolExecutorOptions,
): (call: Tool.Call) => Promise<Tool.Result> {
  const { toolExecutor, engine, getContext, onVerdict } = options;

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const ctx = getContext?.();
    const preVerdict = await engine.dispatch("pre_tool_use", {
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      isCompletion: false,
      continuationCount: 0,
      toolName: call.tool,
      toolCallId: call.id,
      toolInput: call.input,
    });

    onVerdict?.(preVerdict as HookVerdict);

    if (preVerdict.action === "skip") {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Skipped: ${preVerdict.reason ?? "middleware"}]`,
        isError: false,
      };
    }

    if (preVerdict.action === "abort") {
      const reason = preVerdict.reason ?? "middleware";
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: reason.startsWith("Blocked:") ? `[${reason}]` : `[Aborted: ${reason}]`,
        isError: true,
      };
    }

    const effectiveCall =
      preVerdict.action === "transform" && preVerdict.input
        ? { ...call, input: preVerdict.input }
        : call;

    const result = await toolExecutor(effectiveCall);

    const postVerdict = await engine.dispatch("post_tool_use", {
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      isCompletion: false,
      continuationCount: 0,
      toolName: call.tool,
      toolCallId: call.id,
      toolOutput: result.output,
    });

    if (postVerdict.action === "transform") {
      const input = postVerdict.input as Record<string, unknown>;
      if (typeof input.output === "string") {
        return { ...result, output: input.output };
      }
    }

    return result;
  };
}
