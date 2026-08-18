import type { BusEvent, Policy, TraceContext } from "@openomni/protocol";
import { Operational, PolicyDecision, Tool, ToolExecution } from "@openomni/protocol";
import type { AgentStep, TokenUsage } from "../types";
import type { PolicyEngineInstance } from "../policy";
import type { PolicyContext } from "../policy/types";
import { effectOf, effectsOf, matchesToolPattern } from "./effects";
import { nonEmptyString, requireTrace } from "./state";

type BlockedResultMetadata = {
  verdict: Policy.PolicyDecision["verdict"];
  reason: string;
  policyId?: string;
};

export type BlockedToolResult = Tool.Result & { metadata?: BlockedResultMetadata };

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
  getToolDescriptor?: (toolName: string) => Policy.Resource.Descriptor | undefined;
  onToolComplete?: (durationMs: number) => void;
  onDecision?: (timing: Policy.Timing, decision: Policy.PolicyDecision) => void | Promise<void>;
  traceContext?: TraceContext.Type;
  signal?: AbortSignal;
  /** Where this executor's records go. */
  events: BusEvent.Sink;
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
    events,
  } = options;
  // The executor is built inside a turn, which is inside a run that already
  // refused to start without an identity. Minting one here would give a tool
  // call its own trace, detached from the run that made it.
  const configured = requireTrace("tool executor", traceContext);

  function publishDecisionObserverError(
    activeTraceContext: TraceContext.Type,
    timing: Policy.Timing,
    decision: Policy.PolicyDecision,
    err: unknown,
  ): void {
    events.publish(Operational.Warn, {
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
    events.publish(ToolExecution.PermissionDenied, {
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
      traceId: nonEmptyString(callTraceContext?.traceId) ?? configured.traceId,
      sessionId: nonEmptyString(callTraceContext?.sessionId) ?? configured.sessionId,
      runId: nonEmptyString(callTraceContext?.runId) ?? configured.runId,
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
      // RESERVED OBLIGATION SURFACE (#audit M5): `tool.require_approval` is
      // protocol vocabulary for an approval flow that is not wired anywhere —
      // no wait/resume exists in this runtime. Until one does, the only safe
      // honoring of the verdict is a fail-closed denial, and the result must
      // say that instead of implying an approval was requested and refused.
      const approvalRequired = effectOf(preDecision, "tool.require_approval") !== undefined;
      const output = approvalRequired
        ? `[Denied: ${reason} — approval required, but no approval flow is wired; denied fail-closed]`
        : `[Denied: ${reason}]`;
      publishBlocked(eventBase, call, policyToolName, reason);
      return blockedResult(call, output, {
        verdict: preDecision.verdict,
        reason,
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
      return blockedResult(call, `[Denied: ${reason}]`, {
        verdict: postDecision.verdict,
        reason,
        policyId: postDecision.policyId,
      });
    }

    const rewriteOutput = effectOf(postDecision, "tool.rewrite_output");
    return rewriteOutput ? { ...result, output: rewriteOutput.output } : result;
  };
}

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
  readonly descriptor: Policy.Resource.Descriptor;
  readonly kind: "native";
}

interface McpToolPolicyTarget {
  readonly descriptor: Policy.Resource.Descriptor;
  readonly kind: "mcp";
  readonly mcpServerId?: string;
}

type ToolPolicyTarget = NativeToolPolicyTarget | McpToolPolicyTarget;

function mcpServerId(labels: readonly string[] | undefined): string | undefined {
  return Tool.mcpServerFromLabels(labels);
}

function sourceFromLabels(
  labels: readonly string[] | undefined,
): Policy.Resource.Source | undefined {
  const sourceType = Tool.sourceFromLabels(labels);
  if (sourceType === undefined) return undefined;
  if (sourceType === "mcp") {
    const serverId = mcpServerId(labels);
    return serverId === undefined ? { type: sourceType } : { type: sourceType, serverId };
  }
  return { type: sourceType };
}

function policyTarget(
  toolName: string,
  labels: readonly string[] | undefined,
  providedDescriptor: Policy.Resource.Descriptor | undefined,
): ToolPolicyTarget {
  const source = providedDescriptor?.source ?? sourceFromLabels(labels);
  const descriptor: Policy.Resource.Descriptor = providedDescriptor ?? {
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
  descriptor?: Policy.Resource.Descriptor,
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
    const mcpInput = {
      ...input,
      ...(target.mcpServerId === undefined ? {} : { mcpServerId: target.mcpServerId }),
    };
    // Invariant: an mcp target carries a string mcpServerId (resolved from the
    // resource source or an `mcp.` label). When it is genuinely absent the
    // engine's tool.mcp.pre point contract denies fail-closed (context_missing).
    // Narrow ONLY that one boundary field — every other field is checked against
    // the point input type exactly as the native branch below is.
    return engine.dispatchPoint(
      "tool.mcp.pre",
      mcpInput as typeof mcpInput & { mcpServerId: string },
    );
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
  descriptor?: Policy.Resource.Descriptor,
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
    const mcpInput = {
      ...input,
      ...(target.mcpServerId === undefined ? {} : { mcpServerId: target.mcpServerId }),
    };
    // Single-field narrowing as in dispatchToolPre. tool.mcp.post is a
    // FAIL-OPEN post boundary (defaultFailPolicy "fail-open"), so an absent
    // mcpServerId → context_missing → ALLOW, not deny. That is acceptable here:
    // post is a post-hoc observation point, not an authorization gate — the
    // gate already ran at the fail-closed tool.mcp.pre.
    return engine.dispatchPoint(
      "tool.mcp.post",
      mcpInput as typeof mcpInput & { mcpServerId: string },
    );
  }
  return engine.dispatchPoint("tool.native.post", input);
}
