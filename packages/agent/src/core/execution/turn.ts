import type { RunInput } from "@openomni/llm";
import { type Message, Operational, PolicyDecision } from "@openomni/protocol";
import type { BusEvent, Policy, Sink, Tool } from "@openomni/protocol";
import { describeBudgetRemaining, effectiveBudgetThresholds } from "../budget";
import { createAssistantMessage } from "../message-factory";
import type { PolicyEngineInstance } from "../policy";
import * as Retry from "../retry";
import type { AgentResult, ChatAgentConfig, TokenUsage } from "../types";
import { effectOf, PolicyEffectApplier } from "./effects";
import {
  emitBudgetReassurance,
  emitBudgetWarning,
  emitCompaction,
  emitErrorRetry,
  emitTurnComplete,
  guardAbortedResult,
  publishDenyDiagnostic,
  runResult,
} from "./run-events";
import {
  advanceRunContinuation,
  advanceRunTurn,
  appendRunMessages,
  appendRunStep,
  applyCompactionMessages,
  buildLifecyclePolicyContext,
  recordAssistantTokenDelta,
  recordRunToolCall,
  recordRunTurn,
  setLastAssistantText,
  type AgentRunBase,
  type BuildTurnResult,
  type ErrorDecision,
  type RunState,
  type RunTrace,
  type TurnArtifacts,
} from "./state";
import { createToolExecutor } from "./tools";

export function resolveToolChoice(
  config: ChatAgentConfig,
): "auto" | "required" | "none" | undefined {
  return config.toolChoice;
}

export function buildSystemPrompt(
  basePrompt: string | undefined,
  tools: Tool.Spec[],
): string | undefined {
  const toolPrompts = tools
    .filter((t) => t.prompt)
    .map((t) => `## Tool: ${t.name}\n${t.prompt}`)
    .join("\n\n");

  if (!toolPrompts) return basePrompt;
  if (!basePrompt) return toolPrompts;
  return `${basePrompt}\n\n---\n\n${toolPrompts}`;
}

export function assertToolExecutor(config: ChatAgentConfig): void {
  if ((config.tools?.length ?? 0) > 0 && !config.toolExecutor) {
    throw new Error("toolExecutor is required when tools are provided");
  }
}

type ToolPolicyMetadata = Pick<NonNullable<ChatAgentConfig["tools"]>[number], "descriptor"> & {
  readonly labels?: readonly string[];
};

function buildToolMetadataMap(tools: ChatAgentConfig["tools"]): Map<string, ToolPolicyMetadata> {
  const metadata = new Map<string, ToolPolicyMetadata>();
  for (const tool of tools ?? []) {
    const labels = tool.labels ?? tool.descriptor?.labels;
    if (labels === undefined && tool.descriptor === undefined) continue;
    const value = {
      ...(labels !== undefined && { labels }),
      ...(tool.descriptor !== undefined && { descriptor: tool.descriptor }),
    };
    metadata.set(tool.name, value);
    const canonical = labels?.find((label) => label.startsWith("tool:"))?.slice(5);
    if (canonical) metadata.set(canonical, value);
    const dotted = tool.name.replace(/_/g, ".");
    if (dotted !== tool.name) metadata.set(dotted, value);
  }
  return metadata;
}

function resolvePolicyToolName(
  toolName: string,
  metadata: Map<string, ToolPolicyMetadata>,
): string {
  const toolMetadata = metadata.get(toolName) ?? metadata.get(toolName.replace(/_/g, "."));
  const canonical = toolMetadata?.labels?.find((label) => label.startsWith("tool:"));
  return canonical ? canonical.slice(5) : toolName;
}

export async function buildTurn(
  state: RunState,
  config: ChatAgentConfig,
  engine: PolicyEngineInstance,
  providerModel: RunInput["model"],
  configuredToolChoice: RunInput["toolChoice"],
  trace: RunTrace,
  agentBase: AgentRunBase,
  sink?: Sink,
): Promise<BuildTurnResult> {
  const preTurnDecision = await engine.dispatchPoint(
    "run.turn.pre",
    buildLifecyclePolicyContext(state, config, agentBase, { turnIndex: state.turnIndex }),
  );

  if (PolicyDecision.isBlocking(preTurnDecision)) {
    const reason = PolicyDecision.reason(preTurnDecision, "stop");
    return {
      type: "complete",
      result: runResult(state, {
        finishReason: reason === "stalled" ? "stalled" : "stop",
        guardAborted: reason !== "stalled",
      }),
    };
  }

  PolicyEffectApplier.applyPromptMessageEffects(state, preTurnDecision);

  if (preTurnDecision.reasonCodes.includes("budget_reassurance")) {
    const remaining = describeBudgetRemaining(state.budgetState, config.budget);
    emitBudgetReassurance(
      config.events,
      agentBase,
      remaining,
      effectiveBudgetThresholds(config.budget).reassuranceThreshold,
    );
  }
  if (preTurnDecision.reasonCodes.includes("budget_warning")) {
    const remaining = describeBudgetRemaining(state.budgetState, config.budget);
    emitBudgetWarning(
      config.events,
      agentBase,
      remaining,
      effectiveBudgetThresholds(config.budget).warningThreshold,
    );
  }

  recordRunTurn(state);
  if (config.signal?.aborted) throw new Error("aborted");

  const toolPolicyDecisions: TurnArtifacts["toolPolicyDecisions"] = [];
  const toolMetadata = buildToolMetadataMap(config.tools);
  const hookedExecutor = config.toolExecutor
    ? createToolExecutor({
        events: config.events,
        toolExecutor: config.toolExecutor,
        engine,
        getPolicyToolName: (toolName) => resolvePolicyToolName(toolName, toolMetadata),
        getToolLabels: (toolName) => toolMetadata.get(toolName)?.labels,
        getToolDescriptor: (toolName) => toolMetadata.get(toolName)?.descriptor,
        onToolComplete: (durationMs) => {
          recordRunToolCall(state, durationMs);
        },
        getContext: () => ({
          steps: state.steps,
          turnCount: state.budgetState.turns,
          elapsedMs: Date.now() - state.startTime,
          usage: state.totalUsage,
        }),
        onDecision: (_timing, decision) => {
          toolPolicyDecisions.push({ decision });
        },
        traceContext: trace,
        signal: config.signal,
      })
    : undefined;

  const systemResult = await buildTurnSystemPrompt(state, config, engine, agentBase);
  if (systemResult.blocked) {
    return { type: "complete", result: guardAbortedResult(state) };
  }
  const system = systemResult.system;

  const allTools = config.tools ?? [];
  const catalogLabels: Policy.LabelEntry[] = [];
  for (const [name, metadata] of toolMetadata) {
    for (const label of metadata.labels ?? []) {
      catalogLabels.push({ value: `${name}:${label}`, source: "tool_metadata" });
    }
  }
  const toolSelectionDecision = await engine.dispatchPoint(
    "tool.catalog.pre",
    buildLifecyclePolicyContext(state, config, agentBase, {
      labels: catalogLabels,
      availableTools: allTools,
    }),
  );

  if (PolicyDecision.isBlocking(toolSelectionDecision)) {
    return { type: "complete", result: guardAbortedResult(state) };
  }
  const selectedTools = PolicyEffectApplier.applyToolFilterEffects(allTools, toolSelectionDecision);

  const turnUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const turnAssistant: TurnArtifacts["turnAssistant"] = {};
  const trackingSink = createTrackingSink(state, sink, turnUsage, turnAssistant);

  return {
    type: "ready",
    turn: {
      runInput: {
        // llm reports through the same port the agent was handed.
        events: config.events,
        messages: state.messages,
        tools: selectedTools,
        system,
        signal: config.signal,
        model: providerModel,
        auth: config.auth,
        allowAuthFallback: config.allowAuthFallback,
        toolExecutor: hookedExecutor,
        toolChoice: configuredToolChoice,
        maxSteps: config.budget?.maxToolCalls ?? 24,
        providerOptions: config.providerOptions,
        trace: { traceId: trace.traceId, sessionId: trace.sessionId, runId: trace.runId },
      },
      trackingSink,
      turnAssistant,
      turnUsage,
      toolPolicyDecisions,
    },
  };
}

function createTrackingSink(
  state: RunState,
  sink: Sink | undefined,
  turnUsage: TokenUsage,
  turnAssistant: TurnArtifacts["turnAssistant"],
): Sink {
  let prevInputTokens = 0;
  let prevOutputTokens = 0;

  return {
    onMessage: (message: Message.WithParts) => {
      if (message.info.role === "assistant") {
        // Boundary snapshots are immutable fold states (#557); the latest one
        // IS the turn's assistant message — full parts, tool use included.
        // Holding it (instead of re-extracting text) keeps one source of
        // truth for what enters history at turn end (#546).
        turnAssistant.message = message;
        // Tokens arrive once, stamped by message.finished; intermediate
        // boundary snapshots carry zeros, so this delta fires once per attempt.
        const tokens = message.info.tokens;
        const deltaInput = tokens.input - prevInputTokens;
        const deltaOutput = tokens.output - prevOutputTokens;
        prevInputTokens = tokens.input;
        prevOutputTokens = tokens.output;
        if (deltaInput > 0 || deltaOutput > 0) {
          turnUsage.inputTokens += deltaInput;
          turnUsage.outputTokens += deltaOutput;
          turnUsage.totalTokens += deltaInput + deltaOutput;
          recordAssistantTokenDelta(state, deltaInput, deltaOutput);
        }
      }
      const text = message.parts
        .filter((part): part is Message.TextPart => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (text) setLastAssistantText(state, text);
      sink?.onMessage(message);
    },
    onToolCall: (call) => sink?.onToolCall(call),
    onToolResult: (result) => sink?.onToolResult(result),
    // #547 C3: the fact stream passes through untouched — the transcript
    // record family subscribes to facts, not boundary snapshots.
    onFact: (fact) => sink?.onFact?.(fact),
  };
}

async function buildTurnSystemPrompt(
  state: RunState,
  config: ChatAgentConfig,
  engine: PolicyEngineInstance,
  agentBase: AgentRunBase,
): Promise<{ system?: string; blocked?: Policy.PolicyDecision }> {
  let system = buildSystemPrompt(config.systemPrompt, config.tools ?? []);
  const decision = await engine.dispatchPoint(
    "prompt.context.pre",
    buildLifecyclePolicyContext(state, config, agentBase, { turnIndex: state.turnIndex }),
  );
  if (PolicyDecision.isBlocking(decision)) return { system, blocked: decision };

  for (const effect of decision.effects) {
    if (effect.type === "prompt.replace") {
      system = effect.prompt;
    } else if (effect.type === "prompt.append_context") {
      system = system
        ? `${system}

${effect.context}`
        : effect.context;
    } else if (effect.type === "prompt.inject_message") {
      system = system
        ? `${system}

${effect.message}`
        : effect.message;
    }
  }
  return { system };
}

/** The run ends with this result, or it takes another turn. */
export type StopOutcome = AgentResult | "continue";

export async function handleStop(
  state: RunState,
  config: ChatAgentConfig,
  engine: PolicyEngineInstance,
  agentBase: AgentRunBase,
  turn: TurnArtifacts,
): Promise<StopOutcome> {
  emitTurnComplete(config.events, state, agentBase, turn.turnUsage);

  const toolAbort = turn.toolPolicyDecisions.find(
    (entry) => PolicyDecision.isBlocking(entry.decision) && effectOf(entry.decision, "run.abort"),
  );

  const step = { type: "text" as const, content: state.lastAssistantText };
  appendRunStep(state, step);
  if (config.onStepFinish) await config.onStepFinish(step);

  if (toolAbort) return runResult(state, { finishReason: "stop", guardAborted: true });

  // #546: the turn's assistant output always enters history — tool and
  // reasoning parts included, regardless of continuation — and it enters
  // BEFORE run.turn.post dispatch, so history-rewriting policies
  // (run.replace_messages) operate on a history that contains it and stay
  // the final word.
  const assistantMessage = resolveTurnAssistant(config.events, state, turn, agentBase);
  appendRunMessages(state, [assistantMessage]);

  const postTurnDecision = await engine.dispatchPoint(
    "run.turn.post",
    buildLifecyclePolicyContext(state, config, agentBase, {
      isCompletion: true,
      turnIndex: state.turnIndex,
      turnResult: {
        type: "stop",
        text: state.lastAssistantText,
        usage: turn.turnUsage,
      },
    }),
  );

  if (!PolicyDecision.isBlocking(postTurnDecision)) {
    try {
      PolicyEffectApplier.applyMessageReplacementEffect(state, postTurnDecision);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      publishDenyDiagnostic(
        config.events,
        "turn.finish",
        PolicyDecision.deny({
          policyId: "agent.policy.composed",
          reasonCodes: [reason],
          effects: [{ type: "run.abort", reason }],
        }),
        state,
        agentBase,
      );
      return guardAbortedResult(state);
    }
  }

  const continuationMessages = PolicyEffectApplier.continuationMessages(
    postTurnDecision,
    state.sessionId,
    assistantMessage.info.id,
  );
  if (!PolicyDecision.isBlocking(postTurnDecision) && continuationMessages.length > 0) {
    appendRunMessages(state, continuationMessages);
    const blocked = await applyPostCompaction(state, engine, config, agentBase, true);
    if (blocked) return blocked;
    advanceRunContinuation(state);
    return "continue";
  }

  if (PolicyDecision.isBlocking(postTurnDecision)) {
    const reason = PolicyDecision.reason(postTurnDecision, "stop");
    if (effectOf(postTurnDecision, "run.abort")) {
      return runResult(state, {
        finishReason: reason === "stalled" ? "stalled" : "stop",
        guardAborted: reason !== "stalled",
      });
    }
    publishDenyDiagnostic(config.events, "turn.finish", postTurnDecision, state, agentBase);
  }

  await dispatchPostRunTransform(state, engine, config, agentBase);
  return runResult(state, { finishReason: "stop" });
}

export function handleContinue(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
): void {
  emitTurnComplete(events, state, agentBase, turnUsage);
  advanceRunTurn(state);
}

export async function handleCompact(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): Promise<StopOutcome> {
  const blocked = await applyPostCompaction(state, engine, config, agentBase, false);
  if (blocked) return blocked;
  advanceRunTurn(state);
  return "continue";
}

export async function handleError(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  error: unknown,
  attempt: number,
  retryPolicy: Parameters<typeof Retry.shouldRetry>[0],
): Promise<ErrorDecision> {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const onErrorDecision = await engine.dispatchPoint(
    "run.error.error",
    buildLifecyclePolicyContext(state, config, agentBase, {
      toolInput: {
        error: {
          name: normalizedError.name,
          message: normalizedError.message,
          ...(normalizedError.stack === undefined ? {} : { stack: normalizedError.stack }),
        },
      },
      errorCode: normalizedError.name || "Error",
      errorPhase: "agent.run",
    }),
  );

  if (PolicyDecision.isBlocking(onErrorDecision)) {
    if (effectOf(onErrorDecision, "run.abort")) {
      return { action: "complete", result: guardAbortedResult(state) };
    }
    publishDenyDiagnostic(config.events, "error", onErrorDecision, state, agentBase);
  }

  const lastError = normalizedError.message;
  const retryReason = Retry.classifyRetryReason(lastError);
  const retryEffect = effectOf(onErrorDecision, "run.retry_after");
  const effectiveRetryPolicy =
    retryEffect?.maxRetries === undefined
      ? retryPolicy
      : {
          ...retryPolicy,
          maxAttempts: Math.min(retryPolicy.maxAttempts, retryEffect.maxRetries),
        };

  if (Retry.shouldRetry(effectiveRetryPolicy, retryReason, attempt)) {
    const backoffMs = retryEffect?.delayMs ?? Retry.calculateBackoffMs(retryPolicy, attempt);
    emitErrorRetry(config.events, agentBase, {
      attempt,
      maxAttempts: effectiveRetryPolicy.maxAttempts,
      error: lastError,
      reason: retryReason,
      backoffMs,
    });
    return {
      action: "retry",
      backoffMs,
      failure: { reason: retryReason, attempt, maxAttempts: effectiveRetryPolicy.maxAttempts },
    };
  }

  return {
    action: "throw",
    error: normalizedError,
    failure: { reason: retryReason, attempt, maxAttempts: effectiveRetryPolicy.maxAttempts },
  };
}

/**
 * The turn's assistant message is the llm fold's boundary snapshot — the one
 * source of truth for what enters history (#546). The empty-text fallback is
 * a TEST-STUB-ONLY path: every production processor exit emits a finished
 * snapshot (#557), so a missing snapshot means the configured llm run never
 * drove the sink. It is loud (Operational.Error) and deliberately does NOT
 * reuse lastAssistantText, which may still hold the PREVIOUS turn's text —
 * resurrecting it would forge history.
 */
function resolveTurnAssistant(
  events: BusEvent.Sink,
  state: RunState,
  turn: TurnArtifacts,
  agentBase: AgentRunBase,
): Message.WithParts {
  if (turn.turnAssistant.message !== undefined) return turn.turnAssistant.message;
  events.publish(Operational.Error, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId,
    component: "agent.turn",
    msg: "llm sink emitted no assistant snapshot — test stub?",
  });
  const parentID = state.messages.at(-1)?.info.id ?? "";
  return createAssistantMessage("", parentID, state.sessionId);
}

async function dispatchPostRunTransform(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): Promise<void> {
  const postRunDecision = await engine.dispatchPoint(
    "run.lifecycle.post",
    buildLifecyclePolicyContext(state, config, agentBase, {
      isCompletion: true,
      runOutcome: { type: "stop" },
    }),
  );
  if (PolicyDecision.isBlocking(postRunDecision)) {
    publishDenyDiagnostic(config.events, "run.finish", postRunDecision, state, agentBase);
  }
}

async function applyPostCompaction(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  isCompletion: boolean,
): Promise<AgentResult | null> {
  const compactionDecision = await engine.dispatchPoint(
    "run.completion.pre",
    buildLifecyclePolicyContext(state, config, agentBase, {
      isCompletion,
      completionCandidate: {
        isCompletion,
        messages: state.messages,
      },
    }),
  );

  if (PolicyDecision.isBlocking(compactionDecision)) {
    publishDenyDiagnostic(
      config.events,
      "completion.prepare",
      compactionDecision,
      state,
      agentBase,
    );
    return guardAbortedResult(state, { finishReason: "stop" });
  }

  let messages: Message.WithParts[] | undefined;
  try {
    messages = PolicyEffectApplier.replacementMessages(compactionDecision);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    publishDenyDiagnostic(
      config.events,
      "completion.prepare",
      PolicyDecision.deny({
        policyId: "agent.policy.composed",
        reasonCodes: [reason],
        effects: [{ type: "run.abort", reason }],
      }),
      state,
      agentBase,
    );
    return guardAbortedResult(state, { finishReason: "stop" });
  }
  if (messages !== undefined) {
    const messagesBefore = applyCompactionMessages(state, messages);
    emitCompaction(config.events, agentBase, messagesBefore, state.messages.length);
  }
  PolicyEffectApplier.applyPromptMessageEffects(state, compactionDecision);

  return null;
}
