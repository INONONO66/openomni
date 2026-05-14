import type { Policy, Tool, TraceContext } from "@openomni/protocol";
import { ToolExecution } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AgentStep, TokenUsage } from "../types";
import type { PolicyEngineInstance } from "../policy";
import { summarizeInput } from "./shared";

type BlockedResultMetadata = {
  verdict: Policy.Verdict["action"];
  reason: string;
  retryAfterMs?: number;
  policyId?: string;
};

type BlockedToolResult = Tool.Result & { metadata?: BlockedResultMetadata };

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

  function publishBlocked(call: Tool.Call, toolName: string, reason: string): void {
    Bus.publish(ToolExecution.PermissionDenied, {
      ...eventBase,
      toolCallId: call.id,
      toolName,
      reason,
      time: Date.now(),
    });
  }

  function blockedResult(
    call: Tool.Call,
    output: string,
    metadata?: BlockedResultMetadata,
  ): Tool.Result {
    const result: BlockedToolResult = {
      id: crypto.randomUUID(),
      toolCallId: call.id,
      output,
      isError: true,
    };
    if (metadata !== undefined) result.metadata = metadata;
    return result;
  }

  return async (call: Tool.Call): Promise<Tool.Result> => {
    const ctx = getContext?.();
    const policyToolName = getPolicyToolName?.(call.tool) ?? call.tool;
    const usage = ctx?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const preVerdict = await engine.dispatchLegacy("invoke.prepare", {
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

    let effectiveCall = call;
    switch (preVerdict.action) {
      case "continue":
        break;
      case "transform":
        effectiveCall = { ...call, input: preVerdict.input };
        break;
      case "skip":
        return {
          id: crypto.randomUUID(),
          toolCallId: call.id,
          output: `[Skipped: ${preVerdict.reason ?? "middleware"}]`,
          isError: false,
        };
      case "abort": {
        const reason = preVerdict.reason ?? "middleware";
        publishBlocked(call, policyToolName, reason);
        return blockedResult(
          call,
          reason.startsWith("Blocked:") ? `[${reason}]` : `[Aborted: ${reason}]`,
        );
      }
      case "deny": {
        const reason = preVerdict.reason ?? "middleware";
        publishBlocked(call, policyToolName, reason);
        return blockedResult(call, `[Denied: ${reason}]`);
      }
      case "inject": {
        const reason = "inject verdict is not valid for invoke.prepare";
        publishBlocked(call, policyToolName, reason);
        return blockedResult(call, `[Denied: ${reason}]`);
      }
      case "retry": {
        const reason = preVerdict.reason ?? "middleware";
        publishBlocked(call, policyToolName, reason);
        return blockedResult(call, `[Retry requested: ${reason}]`, {
          verdict: "retry",
          reason,
          retryAfterMs: 0,
          ...(preVerdict.policyId !== undefined && { policyId: preVerdict.policyId }),
        });
      }
      default: {
        const exhaustive: never = preVerdict;
        return exhaustive;
      }
    }

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

    const postVerdict = await engine.dispatchLegacy("invoke.result", {
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

    switch (postVerdict.action) {
      case "transform":
        if (typeof postVerdict.input.output === "string") {
          return { ...result, output: postVerdict.input.output };
        }
        return result;
      case "continue":
      case "skip":
      case "abort":
      case "retry":
      case "inject":
      case "deny":
        return result;
      default: {
        const exhaustive: never = postVerdict;
        return exhaustive;
      }
    }
  };
}
