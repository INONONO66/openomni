import type { Tool, TraceContext } from "@openomni/protocol";
import { ToolExecution } from "@openomni/protocol";
import { Bus, Log } from "@openomni/session";
import type { HookContext, HookVerdict, TokenUsage } from "../types";
import type { MiddlewareEngineInstance } from "../middleware";

export interface ToolExecutorOptions {
  toolExecutor: (call: Tool.Call) => Promise<Tool.Result>;
  engine: MiddlewareEngineInstance;
  getContext?: () => Omit<HookContext, "toolName" | "toolCallId" | "input"> & {
    usage?: TokenUsage;
  };
  onVerdict?: (verdict: HookVerdict) => void;
  traceContext?: TraceContext.Type;
}

export function createToolExecutor(
  options: ToolExecutorOptions,
): (call: Tool.Call) => Promise<Tool.Result> {
  const { toolExecutor, engine, getContext, onVerdict, traceContext } = options;
  const traceId = traceContext?.traceId ?? crypto.randomUUID();
  const sessionId = traceContext?.sessionId ?? "";

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const ctx = getContext?.();
    const usage = ctx?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const preVerdict = await engine.dispatch("pre_tool_use", {
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage,
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
      Log.warn("tool execution denied", { toolName: call.tool, toolCallId: call.id, reason });
      Bus.publish(ToolExecution.PermissionDenied, {
        traceId,
        sessionId,
        toolCallId: call.id,
        toolName: call.tool,
        reason,
        time: Date.now(),
      });
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

    Log.debug("tool execution started", { toolName: call.tool, toolCallId: call.id });
    Bus.publish(ToolExecution.Started, {
      traceId,
      sessionId,
      toolCallId: call.id,
      toolName: call.tool,
      time: Date.now(),
    });

    const startMs = Date.now();
    let result: Tool.Result;
    try {
      result = await toolExecutor(effectiveCall);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      Log.error("tool execution threw", { toolName: call.tool, toolCallId: call.id, durationMs });
      Bus.publish(ToolExecution.Completed, {
        traceId,
        sessionId,
        toolCallId: call.id,
        toolName: call.tool,
        durationMs,
        isError: true,
        time: Date.now(),
      });
      throw err;
    }

    const durationMs = Date.now() - startMs;
    Log.debug("tool execution completed", {
      toolName: call.tool,
      toolCallId: call.id,
      durationMs,
      isError: result.isError,
    });
    Bus.publish(ToolExecution.Completed, {
      traceId,
      sessionId,
      toolCallId: call.id,
      toolName: call.tool,
      durationMs,
      isError: result.isError,
      time: Date.now(),
    });

    const postVerdict = await engine.dispatch("post_tool_use", {
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage,
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
