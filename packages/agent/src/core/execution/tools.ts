import type { BusEvent, Policy, TraceContext } from "@openomni/protocol";
import { Operational, PolicyDecision, Tool } from "@openomni/protocol";
import type { AgentStep, TokenUsage } from "../types";
import type { PolicyEngineInstance } from "../policy";
import type { PolicyContext } from "../policy/types";
import { effectOf, effectsOf, matchesToolPattern } from "./effects";
import { nonEmptyString, requireTrace, type RunTrace } from "./state";

type BlockedResultMetadata = {
  verdict: Policy.PolicyDecision["verdict"];
  reason: string;
  policyId?: string;
};

type ToolEventBase = Readonly<{
  traceId: string;
  sessionId: string;
  runId?: string;
  actor?: Record<string, unknown>;
}>;

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
    events.publish(Operational.Events.Warn, {
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
    eventBase: ToolEventBase,
    call: Tool.Call,
    toolName: string,
    reason: string,
  ): void {
    events.publish(Tool.Events.PermissionDenied, {
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
      toolName: call.tool,
      output,
      isError: true,
    };
    if (metadata !== undefined) result.metadata = metadata;
    return result;
  }

  function resolveInvocationTrace(context?: Tool.ExecutionContext): RunTrace {
    const callTraceContext = context?.traceContext;
    return {
      ...traceContext,
      ...callTraceContext,
      traceId: nonEmptyString(callTraceContext?.traceId) ?? configured.traceId,
      sessionId: nonEmptyString(callTraceContext?.sessionId) ?? configured.sessionId,
      runId: nonEmptyString(callTraceContext?.runId) ?? configured.runId,
      agentName: nonEmptyString(traceContext?.agentName),
    };
  }

  function resolveInvocationPolicyMetadata(call: Tool.Call, policyToolName: string) {
    return {
      toolLabels: getToolLabels?.(call.tool) ?? getToolLabels?.(policyToolName),
      toolDescriptor: getToolDescriptor?.(call.tool) ?? getToolDescriptor?.(policyToolName),
    };
  }

  function invocationPolicyContext(
    activeTraceContext: RunTrace,
    ctx: ReturnType<NonNullable<ToolExecutorOptions["getContext"]>> | undefined,
    usage: TokenUsage,
  ): ToolPolicyRunContext {
    return {
      sessionId: activeTraceContext.sessionId,
      runId: activeTraceContext.runId,
      traceContext: activeTraceContext,
      steps: ctx?.steps ?? [],
      turnCount: ctx?.turnCount ?? 0,
      elapsedMs: ctx?.elapsedMs ?? 0,
      usage,
    };
  }

  function prepareInvocation(call: Tool.Call, context?: Tool.ExecutionContext) {
    const activeTraceContext = resolveInvocationTrace(context);
    const agentName = activeTraceContext.agentName;
    const eventBase: ToolEventBase = {
      traceId: activeTraceContext.traceId,
      sessionId: activeTraceContext.sessionId,
      runId: activeTraceContext.runId,
      ...(agentName !== undefined && { actor: { agentName } }),
    };
    const ctx = getContext?.();
    const policyToolName = getPolicyToolName?.(call.tool) ?? call.tool;
    const usage = ctx?.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const metadata = resolveInvocationPolicyMetadata(call, policyToolName);
    return {
      activeTraceContext,
      eventBase,
      policyToolName,
      ...metadata,
      policyContext: invocationPolicyContext(activeTraceContext, ctx, usage),
    };
  }

  function applyPreDecision(
    call: Tool.Call,
    policyToolName: string,
    eventBase: ToolEventBase,
    decision: Policy.PolicyDecision,
  ): Tool.Result | undefined {
    if (PolicyDecision.isBlocking(decision)) {
      const reason = PolicyDecision.reason(decision, "middleware");
      // RESERVED OBLIGATION SURFACE (#audit M5): approval has no wait/resume
      // flow, so the only safe interpretation is a fail-closed denial.
      const approvalRequired = effectOf(decision, "tool.require_approval") !== undefined;
      const output = approvalRequired
        ? `[Denied: ${reason} — approval required, but no approval flow is wired; denied fail-closed]`
        : `[Denied: ${reason}]`;
      publishBlocked(eventBase, call, policyToolName, reason);
      return blockedResult(call, output, {
        verdict: decision.verdict,
        reason,
        policyId: decision.policyId,
      });
    }

    const matchingFilter = effectsOf(decision, "tool.filter").find((effect) =>
      matchesToolPattern(policyToolName, effect.toolPattern),
    );
    if (matchingFilter !== undefined) {
      const reason = PolicyDecision.reason(decision, `filtered: ${matchingFilter.toolPattern}`);
      publishBlocked(eventBase, call, policyToolName, reason);
      return blockedResult(call, `[Denied: ${reason}]`, {
        verdict: decision.verdict,
        reason,
        policyId: decision.policyId,
      });
    }

    const skip = effectOf(decision, "tool.skip_invocation");
    if (skip === undefined) return undefined;
    return {
      id: crypto.randomUUID(),
      toolCallId: call.id,
      toolName: call.tool,
      output: `[Skipped: ${skip.reason ?? PolicyDecision.reason(decision, "middleware")}]`,
      isError: false,
    };
  }

  function applyPostDecision(
    call: Tool.Call,
    policyToolName: string,
    eventBase: ToolEventBase,
    result: Tool.Result,
    decision: Policy.PolicyDecision,
  ): Tool.Result {
    // Post is post-hoc: only run.abort withholds an already-produced result.
    const postAbort = effectOf(decision, "run.abort");
    if (PolicyDecision.isBlocking(decision) && postAbort !== undefined) {
      const reason = postAbort.reason ?? PolicyDecision.reason(decision, "middleware");
      publishBlocked(eventBase, call, policyToolName, reason);
      return blockedResult(call, `[Denied: ${reason}]`, {
        verdict: decision.verdict,
        reason,
        policyId: decision.policyId,
      });
    }

    const rewriteOutput = effectOf(decision, "tool.rewrite_output");
    return rewriteOutput === undefined ? result : { ...result, output: rewriteOutput.output };
  }

  return async (call: Tool.Call, context?: Tool.ExecutionContext): Promise<Tool.Result> => {
    const prepared = prepareInvocation(call, context);
    const preDecision = await dispatchToolPre(
      engine,
      prepared.policyContext,
      prepared.policyToolName,
      call,
      prepared.toolLabels,
      prepared.toolDescriptor,
    );
    recordDecision(prepared.activeTraceContext, "invoke.prepare", preDecision);

    const preResult = applyPreDecision(
      call,
      prepared.policyToolName,
      prepared.eventBase,
      preDecision,
    );
    if (preResult !== undefined) return preResult;

    const rewriteInput = effectOf(preDecision, "tool.rewrite_input");
    const effectiveCall = rewriteInput === undefined ? call : { ...call, input: rewriteInput.input };

    // #522 defect 2: execution telemetry belongs to the injected executor;
    // this layer keeps policy dispatch, decision recording, and effects only.
    const startMs = Date.now();
    let result: Tool.Result;
    try {
      result = await toolExecutor(effectiveCall, {
        signal: context?.signal ?? signal,
        traceContext: prepared.activeTraceContext,
      });
    } catch (err) {
      onToolComplete?.(Date.now() - startMs);
      throw err;
    }
    onToolComplete?.(Date.now() - startMs);

    const postDecision = await dispatchToolPost(
      engine,
      prepared.policyContext,
      prepared.policyToolName,
      call,
      result,
      prepared.toolLabels,
      prepared.toolDescriptor,
    );
    recordDecision(prepared.activeTraceContext, "invoke.result", postDecision);
    return applyPostDecision(
      call,
      prepared.policyToolName,
      prepared.eventBase,
      result,
      postDecision,
    );
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

/** The point-input fields every tool policy point shares, pre and post. */
function toolPointInput(
  context: ToolPolicyRunContext,
  toolName: string,
  call: Tool.Call,
  labels: readonly string[] | undefined,
  target: ReturnType<typeof policyTarget>,
) {
  return {
    ...sharedContext(context),
    toolId: toolName,
    toolName,
    toolCallId: call.id,
    toolLabels: [...(labels ?? target.descriptor.labels)],
    resourceDescriptor: target.descriptor,
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
    ...toolPointInput(context, toolName, call, labels, target),
    toolInput: call.input,
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
    ...toolPointInput(context, toolName, call, labels, target),
    toolOutput: result.output,
    toolResult: result,
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
