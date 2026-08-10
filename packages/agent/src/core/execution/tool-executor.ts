import type { Policy, RuntimeResource, Tool, TraceContext } from "@openomni/protocol";
import { Operational, PolicyDecision, ToolExecution } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { AgentStep, TokenUsage } from "../types";
import type { PolicyEngineInstance } from "../policy";
import type { PolicyContext } from "../policy/types";
import { effectOf, effectsOf, matchesToolPattern } from "./policy-effects";

// merged from shared.ts (fragment sweep); also consumed by policy/builtin/tool-guard.ts
export function summarizeInput(input: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(input);
    return str.length > 100 ? `${str.slice(0, 97)}...` : str;
  } catch {
    return "[unserializable]";
  }
}

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
  const configuredTraceId = nonEmptyString(traceContext?.traceId) ?? crypto.randomUUID();
  const configuredSessionId = nonEmptyString(traceContext?.sessionId) ?? crypto.randomUUID();
  const configuredRunId = nonEmptyString(traceContext?.runId) ?? crypto.randomUUID();

  function publishDecisionObserverError(
    activeTraceContext: TraceContext.Type,
    timing: Policy.Timing,
    decision: Policy.PolicyDecision,
    err: unknown,
  ): void {
    Bus.publish(Operational.Warn, {
      traceId: activeTraceContext.traceId,
      time: Date.now(),
      component: "agent.tool-executor",
      msg: "onDecision observer error",
      context: { timing, policyId: decision.policyId, error: String(err) },
    });
  }

  function recordDecision(
    activeTraceContext: TraceContext.Type,
    timing: Policy.Timing,
    decision: Policy.PolicyDecision,
  ): void {
    try {
      void Promise.resolve(onDecision?.(timing, decision)).catch((err) => {
        publishDecisionObserverError(activeTraceContext, timing, decision, err);
      });
    } catch (err) {
      const error = err instanceof Error ? err : String(err);
      publishDecisionObserverError(activeTraceContext, timing, decision, error);
    }
  }

  function publishBlocked(
    eventBase: Readonly<{
      traceId: string;
      sessionId: string;
      runId?: string;
      actor?: Record<string, unknown>;
    }>,
    call: Tool.Call,
    toolName: string,
    reason: string,
  ): void {
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
    const callTraceContext = context?.traceContext;
    const activeTraceContext = {
      ...traceContext,
      ...callTraceContext,
      traceId: nonEmptyString(callTraceContext?.traceId) ?? configuredTraceId,
      sessionId: nonEmptyString(callTraceContext?.sessionId) ?? configuredSessionId,
      runId: nonEmptyString(callTraceContext?.runId) ?? configuredRunId,
      agentName: nonEmptyString(traceContext?.agentName),
    } satisfies TraceContext.Type;
    const agentName = activeTraceContext.agentName;
    const eventBase = {
      traceId: activeTraceContext.traceId,
      sessionId: activeTraceContext.sessionId,
      runId: activeTraceContext.runId,
      ...(agentName !== undefined && { actor: { agentName } }),
    };
    const ctx = getContext?.();
    const policyToolName = getPolicyToolName?.(call.tool) ?? call.tool;
    const usage = ctx?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const toolLabels = getToolLabels?.(call.tool) ?? getToolLabels?.(policyToolName);
    const toolDescriptor = getToolDescriptor?.(call.tool) ?? getToolDescriptor?.(policyToolName);
    const policyContext = {
      sessionId: activeTraceContext.sessionId,
      runId: activeTraceContext.runId,
      traceContext: activeTraceContext,
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

    recordDecision(activeTraceContext, "invoke.prepare", preDecision);

    if (PolicyDecision.isBlocking(preDecision)) {
      const reason = PolicyDecision.reason(preDecision, "middleware");
      publishBlocked(eventBase, call, policyToolName, reason);
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
      publishBlocked(eventBase, call, policyToolName, reason);
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

    // #522 defect 2: ToolExecution.Started/Completed are emitted SOLELY by
    // the worker-side executor this wrapper delegates to (packages/openomni
    // execution-runtime/tool/executor.ts) — this layer keeps policy point
    // dispatch, decision recording, and effect application only.
    const startMs = Date.now();
    let result: Tool.Result;
    try {
      result = await toolExecutor(effectiveCall, {
        signal: context?.signal ?? signal,
        traceContext: activeTraceContext,
      });
    } catch (err) {
      onToolComplete?.(Date.now() - startMs);
      throw err;
    }

    onToolComplete?.(Date.now() - startMs);

    const postDecision = await dispatchToolPost(
      engine,
      policyContext,
      policyToolName,
      call,
      result,
      toolLabels,
      toolDescriptor,
    );

    recordDecision(activeTraceContext, "invoke.result", postDecision);
    const postAbort = effectOf(postDecision, "run.abort");
    if (PolicyDecision.isBlocking(postDecision) && postAbort) {
      const reason = postAbort.reason ?? PolicyDecision.reason(postDecision, "middleware");
      publishBlocked(eventBase, call, policyToolName, reason);
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// merged from tool-policy-dispatch.ts (250-LOC split refold: single-importer stage)
interface ToolPolicyRunContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly traceContext: TraceContext.Type;
  readonly steps: AgentStep[];
  readonly turnCount: number;
  readonly elapsedMs: number;
  readonly usage: TokenUsage;
}

interface NativeToolPolicyTarget {
  readonly descriptor: RuntimeResource.Descriptor;
  readonly kind: "native";
}

interface McpToolPolicyTarget {
  readonly descriptor: RuntimeResource.Descriptor;
  readonly kind: "mcp";
  readonly mcpServerId?: string;
}

type ToolPolicyTarget = NativeToolPolicyTarget | McpToolPolicyTarget;

function mcpServerId(labels: readonly string[] | undefined): string | undefined {
  return labels?.find((label) => label.startsWith("mcp."))?.slice("mcp.".length);
}

function sourceFromLabels(
  labels: readonly string[] | undefined,
): RuntimeResource.Source | undefined {
  const sourceLabel = labels?.find(
    (label) => label.startsWith("source.") || label.startsWith("source:"),
  );
  const sourceType = sourceLabel?.replace(/^source[.:]/, "");
  if (sourceType === "mcp" || sourceType === "skill-mcp") {
    const serverId = mcpServerId(labels);
    return serverId === undefined ? { type: sourceType } : { type: sourceType, serverId };
  }
  if (sourceType === "agent") return { type: "agent" };
  if (sourceType === "server") return { type: "server" };
  if (sourceType === "system") return { type: "system" };
  return undefined;
}

function policyTarget(
  toolName: string,
  labels: readonly string[] | undefined,
  providedDescriptor: RuntimeResource.Descriptor | undefined,
): ToolPolicyTarget {
  const source = providedDescriptor?.source ?? sourceFromLabels(labels);
  const descriptor: RuntimeResource.Descriptor = providedDescriptor ?? {
    id: source ? `tool:${source.type}:${toolName}` : `tool:${toolName}`,
    kind: "tool",
    labels: labels ? [...labels] : [],
    capabilities: [],
    effects: [],
  };
  if (providedDescriptor === undefined && source !== undefined) descriptor.source = source;
  const serverId =
    source?.type === "mcp" || source?.type === "skill-mcp"
      ? (source.serverId ?? mcpServerId(labels))
      : undefined;
  const kind = source?.type === "mcp" || source?.type === "skill-mcp" ? "mcp" : "native";
  if (kind === "native") return { descriptor, kind };
  return { descriptor, kind, ...(serverId === undefined ? {} : { mcpServerId: serverId }) };
}

function sharedContext(context: ToolPolicyRunContext): Omit<
  PolicyContext,
  "timing" | "sessionId" | "runId"
> & {
  readonly sessionId: string;
  readonly runId: string;
} {
  return {
    sessionId: context.sessionId,
    runId: context.runId,
    traceContext: context.traceContext,
    steps: context.steps,
    turnCount: context.turnCount,
    elapsedMs: context.elapsedMs,
    usage: context.usage,
    isCompletion: false,
    continuationCount: 0,
  };
}

async function dispatchToolPre(
  engine: PolicyEngineInstance,
  context: ToolPolicyRunContext,
  toolName: string,
  call: Tool.Call,
  labels: readonly string[] | undefined,
  descriptor?: RuntimeResource.Descriptor,
): Promise<Policy.PolicyDecision> {
  const target = policyTarget(toolName, labels, descriptor);
  const input = {
    ...sharedContext(context),
    toolId: toolName,
    toolName,
    toolCallId: call.id,
    toolLabels: [...(labels ?? target.descriptor.labels)],
    toolInput: call.input,
    resourceDescriptor: target.descriptor,
  };
  if (target.kind === "mcp") {
    return engine.dispatchPoint("tool.mcp.pre", {
      ...input,
      ...(target.mcpServerId === undefined ? {} : { mcpServerId: target.mcpServerId }),
    } as unknown as Policy.PolicyPointInputMap["tool.mcp.pre"] & PolicyContext);
  }
  return engine.dispatchPoint("tool.native.pre", input);
}

async function dispatchToolPost(
  engine: PolicyEngineInstance,
  context: ToolPolicyRunContext,
  toolName: string,
  call: Tool.Call,
  result: Tool.Result,
  labels: readonly string[] | undefined,
  descriptor?: RuntimeResource.Descriptor,
): Promise<Policy.PolicyDecision> {
  const target = policyTarget(toolName, labels, descriptor);
  const input = {
    ...sharedContext(context),
    toolId: toolName,
    toolName,
    toolCallId: call.id,
    toolLabels: [...(labels ?? target.descriptor.labels)],
    toolOutput: result.output,
    toolResult: result,
    resourceDescriptor: target.descriptor,
  };
  if (target.kind === "mcp") {
    return engine.dispatchPoint("tool.mcp.post", {
      ...input,
      ...(target.mcpServerId === undefined ? {} : { mcpServerId: target.mcpServerId }),
    } as unknown as Policy.PolicyPointInputMap["tool.mcp.post"] & PolicyContext);
  }
  return engine.dispatchPoint("tool.native.post", input);
}
