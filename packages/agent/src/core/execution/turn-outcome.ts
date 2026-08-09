import { type Message, PolicyDecision } from "@openomni/protocol";
import { effectOf, PolicyEffectApplier } from "./policy-effects";
import { createAssistantMessage } from "../message-factory";
import * as Retry from "../retry";
import type { AgentEvent, ChatAgentConfig, TokenUsage } from "../types";
import {
  createGuardCompleteEvent,
  createRunCompleteEvent,
  createRunErrorEvent,
  emitCompaction,
  emitErrorRetry,
  emitRunCompleted,
  emitRunFailed,
  emitTurnComplete,
  publishDenyDiagnostic,
} from "./run-events";
import {
  advanceRunContinuation,
  advanceRunTurn,
  applyCompactionMessages,
  buildLifecyclePolicyContext,
  appendRunMessages,
  appendRunStep,
  type ErrorDecision,
  type AgentRunBase,
  type RunState,
  type TurnArtifacts,
  type TurnDecision,
} from "./run-state";
import type { PolicyEngineInstance } from "../policy";

export async function* handleStop(
  state: RunState,
  config: ChatAgentConfig,
  engine: PolicyEngineInstance,
  agentBase: AgentRunBase,
  turn: TurnArtifacts,
): AsyncGenerator<AgentEvent, "complete" | "continue"> {
  emitTurnComplete(state, config, agentBase, turn.turnUsage);

  if (state.lastAssistantText) yield { type: "text_chunk", text: state.lastAssistantText };
  for (const toolCall of turn.turnToolCalls) {
    yield { type: "tool_call_start", ...toolCall };
  }
  for (const toolResult of turn.turnToolResults) {
    yield { type: "tool_call_complete", ...toolResult };
  }
  for (const entry of turn.toolPolicyDecisions) {
    yield {
      type: "hook_verdict",
      timing: entry.timing,
      action: entry.decision.verdict,
      reason: PolicyDecision.reason(entry.decision, undefined),
    };
  }

  const toolAbort = turn.toolPolicyDecisions.find(
    (entry) => PolicyDecision.isBlocking(entry.decision) && effectOf(entry.decision, "run.abort"),
  );

  yield { type: "turn_complete", turnIndex: state.turnIndex, usage: turn.turnUsage };

  const step = { type: "text" as const, content: state.lastAssistantText };
  appendRunStep(state, step);
  if (config.onStepFinish) await config.onStepFinish(step);

  if (toolAbort) {
    const event = createRunCompleteEvent(state, { finishReason: "stop", guardAborted: true });
    yield event;
    return "complete";
  }

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

  yield {
    type: "hook_verdict",
    timing: "turn.finish",
    action: postTurnDecision.verdict,
    reason: PolicyDecision.reason(postTurnDecision, undefined),
  };

  if (!PolicyDecision.isBlocking(postTurnDecision)) {
    try {
      PolicyEffectApplier.applyMessageReplacementEffect(state, postTurnDecision);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      publishDenyDiagnostic(
        "turn.finish",
        PolicyDecision.deny({
          policyId: "agent.policy.composed",
          reasonCodes: [reason],
          effects: [{ type: "run.abort", reason }],
        }),
        state,
        config,
        agentBase,
      );
      yield createGuardCompleteEvent(state);
      return "complete";
    }
  }

  const parentID = state.messages.at(-1)?.info.id ?? "";
  const assistantMessage = createAssistantMessage(
    state.lastAssistantText,
    parentID,
    state.sessionId,
  );
  const continuationMessages = PolicyEffectApplier.continuationMessages(
    postTurnDecision,
    state.sessionId,
    assistantMessage.info.id,
  );
  if (!PolicyDecision.isBlocking(postTurnDecision) && continuationMessages.length > 0) {
    appendRunMessages(state, [assistantMessage, ...continuationMessages]);
    const blocked = await applyPostCompaction(state, engine, config, agentBase, true);
    if (blocked) {
      yield blocked;
      return "complete";
    }
    advanceRunContinuation(state);
    return flowDecision(continueDecision(state));
  }

  if (PolicyDecision.isBlocking(postTurnDecision)) {
    const reason = PolicyDecision.reason(postTurnDecision, "stop");
    if (effectOf(postTurnDecision, "run.abort")) {
      const event = createRunCompleteEvent(state, {
        finishReason: reason === "stalled" ? "stalled" : "stop",
        guardAborted: reason !== "stalled",
      });
      yield event;
      return flowDecision({ kind: "abort", event });
    }
    publishDenyDiagnostic("turn.finish", postTurnDecision, state, config, agentBase);
  }

  await dispatchPostRunTransform(state, engine, config, agentBase);
  emitRunCompleted(state, agentBase, "stop");
  const event = createRunCompleteEvent(state, { finishReason: "stop" });
  yield event;
  return flowDecision({ kind: "complete", event });
}

export async function* handleContinue(
  state: RunState,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
): AsyncGenerator<AgentEvent, "continue"> {
  emitTurnComplete(state, config, agentBase, turnUsage);
  yield { type: "turn_complete", turnIndex: state.turnIndex, usage: turnUsage };
  advanceRunTurn(state);
  return continueFlowDecision(continueDecision(state));
}

export async function handleCompact(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
): Promise<"continue" | AgentEvent> {
  const blocked = await applyPostCompaction(state, engine, config, agentBase, false);
  if (blocked) return blocked;
  advanceRunTurn(state);
  return continueFlowDecision(continueDecision(state));
}

export async function* handleError(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  error: unknown,
  attempt: number,
  retryPolicy: Parameters<typeof Retry.shouldRetry>[0],
): AsyncGenerator<AgentEvent, ErrorDecision> {
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
      const event: AgentEvent = createGuardCompleteEvent(state);
      yield event;
      return { action: "complete", kind: "abort", event, errorMessage: normalizedError.message };
    }
    publishDenyDiagnostic("error", onErrorDecision, state, config, agentBase);
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
    emitErrorRetry(state, config, agentBase, {
      attempt,
      maxAttempts: effectiveRetryPolicy.maxAttempts,
      error: lastError,
    });
    yield createRunErrorEvent(normalizedError, true);
    await Retry.sleep(backoffMs, config.signal);
    return { action: "retry", kind: "error", error: normalizedError, errorMessage: lastError };
  }

  emitRunFailed(agentBase, lastError);
  yield createRunErrorEvent(normalizedError, false);
  return { action: "throw", kind: "error", error: normalizedError, errorMessage: lastError };
}

function continueDecision(state: RunState): Extract<TurnDecision, { kind: "continue" }> {
  return {
    kind: "continue",
    messages: state.messages,
    continuationCount: state.continuationCount,
    compactionCount: state.compactionCount,
    turnIndex: state.turnIndex,
  };
}

function flowDecision(decision: Exclude<TurnDecision, { kind: "error" }>): "continue" | "complete" {
  return decision.kind === "continue" ? "continue" : "complete";
}

function continueFlowDecision(decision: Extract<TurnDecision, { kind: "continue" }>): "continue" {
  return decision.kind;
}

// merged from completion-policy.ts (250-LOC split refold: single-importer stage)
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
    publishDenyDiagnostic("run.finish", postRunDecision, state, config, agentBase);
  }
}

async function applyPostCompaction(
  state: RunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: AgentRunBase,
  isCompletion: boolean,
): Promise<AgentEvent | null> {
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
    publishDenyDiagnostic("completion.prepare", compactionDecision, state, config, agentBase);
    return createGuardCompleteEvent(state, { finishReason: "stop" });
  }

  let messages: Message.WithParts[] | undefined;
  try {
    messages = PolicyEffectApplier.replacementMessages(compactionDecision);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    publishDenyDiagnostic(
      "completion.prepare",
      PolicyDecision.deny({
        policyId: "agent.policy.composed",
        reasonCodes: [reason],
        effects: [{ type: "run.abort", reason }],
      }),
      state,
      config,
      agentBase,
    );
    return createGuardCompleteEvent(state, { finishReason: "stop" });
  }
  if (messages !== undefined) {
    const messagesBefore = applyCompactionMessages(state, messages);
    emitCompaction(agentBase, messagesBefore, state.messages.length);
  }
  PolicyEffectApplier.applyPromptMessageEffects(state, compactionDecision);

  return null;
}
