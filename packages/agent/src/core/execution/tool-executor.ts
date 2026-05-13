import type { Policy, Tool, TraceContext } from "@openomni/protocol";
import { ToolExecution } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AgentStep, TokenUsage } from "../types";
import type { PolicyEngineInstance } from "../policy";
import { summarizeInput } from "./shared";

export interface ToolExecutorOptions {
  toolExecutor: (call: Tool.Call) => Promise<Tool.Result>;
  engine: PolicyEngineInstance;
  getContext?: () => {
    steps: AgentStep[];
    turnCount: number;
    elapsedMs: number;
    usage?: TokenUsage;
  };
  getPolicyToolName?: (toolName: string) => string | undefined;
  getToolLabels?: (toolName: string) => string[] | undefined;
  onToolComplete?: (durationMs: number) => void;
  onVerdict?: (verdict: Policy.Verdict) => void;
  traceContext?: TraceContext.Type;
}

export function createToolExecutor(
  options: ToolExecutorOptions,
): (call: Tool.Call) => Promise<Tool.Result> {
  const {
    toolExecutor,
    engine,
    getContext,
    getPolicyToolName,
    getToolLabels,
    onToolComplete,
    onVerdict,
    traceContext,
  } = options;
  const traceId = traceContext?.traceId ?? crypto.randomUUID();
  const sessionId = traceContext?.sessionId ?? "";
  const eventBase = {
    traceId,
    sessionId,
    ...(traceContext?.runId !== undefined && { runId: traceContext.runId }),
    ...(traceContext?.agentName !== undefined && { actor: { agentName: traceContext.agentName } }),
  };

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const ctx = getContext?.();
    const policyToolName = getPolicyToolName?.(call.tool) ?? call.tool;
    const usage = ctx?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const preVerdict = await engine.dispatch("pre_tool_use", {
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage,
      isCompletion: false,
      continuationCount: 0,
      toolName: policyToolName,
      toolCallId: call.id,
      toolLabels: getToolLabels?.(call.tool) ?? getToolLabels?.(policyToolName),
      toolInput: call.input,
    });

    onVerdict?.(preVerdict);

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
      Bus.publish(ToolExecution.PermissionDenied, {
        ...eventBase,
        toolCallId: call.id,
        toolName: policyToolName,
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

    Bus.publish(ToolExecution.Started, {
      ...eventBase,
      toolCallId: call.id,
      toolName: policyToolName,
      inputSummary: summarizeInput(effectiveCall.input),
      time: Date.now(),
    });

    const startMs = Date.now();
    let result: Tool.Result;
    try {
      result = await toolExecutor(effectiveCall);
    } catch (err) {
      const durationMs = Date.now() - startMs;
      onToolComplete?.(durationMs);
      Bus.publish(ToolExecution.Completed, {
        ...eventBase,
        toolCallId: call.id,
        toolName: policyToolName,
        durationMs,
        isError: true,
        time: Date.now(),
      });
      throw err;
    }

    const durationMs = Date.now() - startMs;
    onToolComplete?.(durationMs);
    Bus.publish(ToolExecution.Completed, {
      ...eventBase,
      toolCallId: call.id,
      toolName: policyToolName,
      durationMs,
      isError: result.isError ?? false,
      time: Date.now(),
    });

    const postVerdict = await engine.dispatch("post_tool_use", {
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage,
      isCompletion: false,
      continuationCount: 0,
      toolName: policyToolName,
      toolCallId: call.id,
      toolLabels: getToolLabels?.(call.tool) ?? getToolLabels?.(policyToolName),
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
