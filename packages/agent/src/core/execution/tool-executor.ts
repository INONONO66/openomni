import type { Policy, RuntimeResource, Tool, TraceContext } from "@openomni/protocol";
import { PolicyDecision, ToolExecution } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AgentStep, TokenUsage } from "../types";
import type { PolicyEngineInstance } from "../policy";
import { summarizeInput } from "./shared";

type BlockedResultMetadata = {
  verdict: Policy.PolicyDecision["verdict"];
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
  onDecision?: (timing: Policy.Timing, decision: Policy.PolicyDecision) => void;
  traceContext?: TraceContext.Type;
}

function sourceFromLabels(
  labels: readonly string[] | undefined,
): RuntimeResource.Source | undefined {
  const sourceLabel = labels?.find(
    (label) => label.startsWith("source.") || label.startsWith("source:"),
  );
  const sourceType = sourceLabel?.replace(/^source[.:]/, "");
  if (sourceType === "mcp") return { type: "mcp" };
  if (sourceType === "skill-mcp") return { type: "skill-mcp" };
  if (sourceType === "agent") return { type: "agent" };
  if (sourceType === "server") return { type: "server" };
  if (sourceType === "system") return { type: "system" };
  return undefined;
}

function toolDescriptor(
  toolName: string,
  labels: readonly string[] | undefined,
): RuntimeResource.Descriptor {
  const source = sourceFromLabels(labels);
  const descriptor: RuntimeResource.Descriptor = {
    id: source ? `tool:${source.type}:${toolName}` : `tool:${toolName}`,
    kind: "tool",
    labels: labels ? [...labels] : [],
    capabilities: [],
    effects: [],
  };
  if (source !== undefined) descriptor.source = source;
  return descriptor;
}

function effectOf<T extends Policy.PolicyEffect["type"]>(
  decision: Policy.PolicyDecision,
  type: T,
): Extract<Policy.PolicyEffect, { type: T }> | undefined {
  return decision.effects.find(
    (effect): effect is Extract<Policy.PolicyEffect, { type: T }> => effect.type === type,
  );
}

function effectsOf<T extends Policy.PolicyEffect["type"]>(
  decision: Policy.PolicyDecision,
  type: T,
): Array<Extract<Policy.PolicyEffect, { type: T }>> {
  return decision.effects.filter(
    (effect): effect is Extract<Policy.PolicyEffect, { type: T }> => effect.type === type,
  );
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return toolName.startsWith(`${pattern.slice(0, -2)}.`);
  return toolName === pattern;
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
    onDecision,
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
    const toolLabels = getToolLabels?.(call.tool) ?? getToolLabels?.(policyToolName);
    const preDecision = await engine.dispatch("invoke.prepare", {
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage,
      isCompletion: false,
      continuationCount: 0,
      toolName: policyToolName,
      toolCallId: call.id,
      toolLabels,
      toolInput: call.input,
      resourceDescriptor: toolDescriptor(policyToolName, toolLabels),
    });

    onDecision?.("invoke.prepare", preDecision);

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

    const postDecision = await engine.dispatch("invoke.result", {
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage,
      isCompletion: false,
      continuationCount: 0,
      toolName: policyToolName,
      toolCallId: call.id,
      toolLabels,
      toolOutput: result.output,
      resourceDescriptor: toolDescriptor(policyToolName, toolLabels),
    });

    onDecision?.("invoke.result", postDecision);
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
