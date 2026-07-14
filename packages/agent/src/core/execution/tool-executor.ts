import type { Policy, RuntimeResource, Tool, TraceContext } from "@openomni/protocol";
import { Operational, PolicyDecision, ToolExecution } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AgentStep, TokenUsage } from "../types";
import type { PolicyEngineInstance } from "../policy";
import { effectOf, effectsOf, matchesToolPattern } from "./policy-effects";
import { summarizeInput } from "./shared";
import { dispatchToolPost, dispatchToolPre } from "./tool-policy-dispatch";

type BlockedResultMetadata = {
  verdict: Policy.PolicyDecision["verdict"];
  reason: string;
  retryAfterMs?: number;
  policyId?: string;
};

type BlockedToolResult = Tool.Result & { metadata?: BlockedResultMetadata };

export interface ToolExecutorOptions {
  toolExecutor: (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result>;
  engine: PolicyEngineInstance;
  getContext?: () => {
    steps: AgentStep[];
    turnCount: number;
    elapsedMs: number;
    usage?: TokenUsage;
  };
  getPolicyToolName?: (toolName: string) => string | undefined;
  getToolLabels?: (toolName: string) => readonly string[] | undefined;
  getToolDescriptor?: (toolName: string) => RuntimeResource.Descriptor | undefined;
  onToolComplete?: (durationMs: number) => void;
  onDecision?: (timing: Policy.Timing, decision: Policy.PolicyDecision) => void | Promise<void>;
  traceContext?: TraceContext.Type;
  signal?: AbortSignal;
}

export function createToolExecutor(
  options: ToolExecutorOptions,
): (call: Tool.Call, context?: Tool.ExecutionContext) => Promise<Tool.Result> {
  const {
    toolExecutor,
    engine,
    getContext,
    getPolicyToolName,
    getToolLabels,
    getToolDescriptor,
    onToolComplete,
    onDecision,
    traceContext,
    signal,
  } = options;
  const traceId = traceContext?.traceId ?? crypto.randomUUID();
  const eventSessionId = traceContext?.sessionId ?? "";
  const policySessionId = traceContext?.sessionId ?? crypto.randomUUID();
  const policyRunId = traceContext?.runId ?? crypto.randomUUID();
  const eventBase = {
    traceId,
    sessionId: eventSessionId,
    ...(traceContext?.runId !== undefined && { runId: traceContext.runId }),
    ...(traceContext?.agentName !== undefined && { actor: { agentName: traceContext.agentName } }),
  };

  function publishDecisionObserverError(
    timing: Policy.Timing,
    decision: Policy.PolicyDecision,
    err: unknown,
  ): void {
    Bus.publish(Operational.Warn, {
      traceId,
      time: Date.now(),
      component: "agent.tool-executor",
      msg: "onDecision observer error",
      context: { timing, policyId: decision.policyId, error: String(err) },
    });
  }

  function recordDecision(timing: Policy.Timing, decision: Policy.PolicyDecision): void {
    try {
      void Promise.resolve(onDecision?.(timing, decision)).catch((err) => {
        publishDecisionObserverError(timing, decision, err);
      });
    } catch (err) {
      const error = err instanceof Error ? err : String(err);
      publishDecisionObserverError(timing, decision, error);
    }
  }

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

  return async (call: Tool.Call, context?: Tool.ExecutionContext): Promise<Tool.Result> => {
    const ctx = getContext?.();
    const policyToolName = getPolicyToolName?.(call.tool) ?? call.tool;
    const usage = ctx?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const toolLabels = getToolLabels?.(call.tool) ?? getToolLabels?.(policyToolName);
    const toolDescriptor = getToolDescriptor?.(call.tool) ?? getToolDescriptor?.(policyToolName);
    const policyContext = {
      sessionId: policySessionId,
      runId: policyRunId,
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage,
    };
    const preDecision = await dispatchToolPre(
      engine,
      policyContext,
      policyToolName,
      call,
      toolLabels,
      toolDescriptor,
    );

    recordDecision("invoke.prepare", preDecision);

    if (PolicyDecision.isBlocking(preDecision)) {
      const reason = PolicyDecision.reason(preDecision, "middleware");
      publishBlocked(call, policyToolName, reason);
      const retry = effectOf(preDecision, "run.retry_after");
      return blockedResult(call, `[Denied: ${reason}]`, {
        verdict: preDecision.verdict,
        reason,
        ...(retry !== undefined && { retryAfterMs: retry.delayMs }),
        policyId: preDecision.policyId,
      });
    }

    const matchingFilter = effectsOf(preDecision, "tool.filter").find((effect) =>
      matchesToolPattern(policyToolName, effect.toolPattern),
    );
    if (matchingFilter) {
      const reason = PolicyDecision.reason(preDecision, `filtered: ${matchingFilter.toolPattern}`);
      publishBlocked(call, policyToolName, reason);
      return blockedResult(call, `[Denied: ${reason}]`, {
        verdict: preDecision.verdict,
        reason,
        policyId: preDecision.policyId,
      });
    }

    const skip = effectOf(preDecision, "tool.skip_invocation");
    if (skip) {
      return {
        id: crypto.randomUUID(),
        toolCallId: call.id,
        output: `[Skipped: ${skip.reason ?? PolicyDecision.reason(preDecision, "middleware")}]`,
        isError: false,
      };
    }

    const rewriteInput = effectOf(preDecision, "tool.rewrite_input");
    const effectiveCall = rewriteInput ? { ...call, input: rewriteInput.input } : call;

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
      const executionTraceContext = context?.traceContext ?? traceContext;
      result = await toolExecutor(effectiveCall, {
        signal: context?.signal ?? signal,
        ...(executionTraceContext !== undefined && { traceContext: executionTraceContext }),
      });
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

    const postDecision = await dispatchToolPost(
      engine,
      policyContext,
      policyToolName,
      call,
      result,
      toolLabels,
      toolDescriptor,
    );

    recordDecision("invoke.result", postDecision);
    const postAbort = effectOf(postDecision, "run.abort");
    if (PolicyDecision.isBlocking(postDecision) && postAbort) {
      const reason = postAbort.reason ?? PolicyDecision.reason(postDecision, "middleware");
      publishBlocked(call, policyToolName, reason);
      const retry = effectOf(postDecision, "run.retry_after");
      return blockedResult(call, `[Denied: ${reason}]`, {
        verdict: postDecision.verdict,
        reason,
        ...(retry !== undefined && { retryAfterMs: retry.delayMs }),
        policyId: postDecision.policyId,
      });
    }

    const rewriteOutput = effectOf(postDecision, "tool.rewrite_output");
    return rewriteOutput ? { ...result, output: rewriteOutput.output } : result;
  };
}
