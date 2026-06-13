import { PolicyDecision } from "@openomni/protocol";
import { effectOf } from "./policy-effects";
import { createAssistantMessage, createUserMessage } from "../message-factory";
import * as Retry from "../retry";
import type { AgentEvent, ChatAgentConfig, TokenUsage } from "../types";
import {
  emitErrorRetry,
  emitRunCompleted,
  emitRunFailed,
  emitTurnComplete,
  publishDenyDiagnostic,
} from "./stream-events";
import { dispatchPostRunTransform, applyPostCompaction } from "./stream-completion-policy";
import { buildLifecyclePolicyContext } from "./stream-policy-context";
import { StreamPolicyEffects } from "./stream-policy-effects";
import {
  createGuardCompleteEvent,
  createStreamCompleteEvent,
  createStreamErrorEvent,
  errorMessage,
} from "./stream-result";
import {
  advanceStreamContinuation,
  advanceStreamTurn,
  appendStreamMessages,
  appendStreamStep,
  type ErrorDecision,
  type StreamAgentBase,
  type StreamRunState,
  type TurnArtifacts,
  type TurnDecision,
} from "./stream-state";
import type { PolicyEngineInstance } from "../policy";

export async function* handleStop(
  state: StreamRunState,
  config: ChatAgentConfig,
  engine: PolicyEngineInstance,
  agentBase: StreamAgentBase,
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
  appendStreamStep(state, step);
  if (config.onStepFinish) await config.onStepFinish(step);

  if (toolAbort) {
    const event = createStreamCompleteEvent(state, { finishReason: "stop", guardAborted: true });
    yield event;
    return "complete";
  }

  const postTurnDecision = await engine.dispatch(
    "turn.finish",
    buildLifecyclePolicyContext(state, config, {
      isCompletion: true,
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
      StreamPolicyEffects.applyMessageReplacementEffect(state, postTurnDecision);
    } catch (error) {
      const reason = errorMessage(error);
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

  const continuationPrompts = StreamPolicyEffects.injectedPrompts(postTurnDecision);
  if (!PolicyDecision.isBlocking(postTurnDecision) && continuationPrompts.length > 0) {
    const parentID = state.messages.at(-1)?.info.id ?? "";
    appendStreamMessages(state, [
      createAssistantMessage(state.lastAssistantText, parentID, state.sessionId),
      ...continuationPrompts.map((prompt) => createUserMessage(prompt, state.sessionId)),
    ]);
    const blocked = await applyPostCompaction(state, engine, config, agentBase, true);
    if (blocked) {
      yield blocked;
      return "complete";
    }
    advanceStreamContinuation(state);
    return flowDecision(continueDecision(state));
  }

  if (PolicyDecision.isBlocking(postTurnDecision)) {
    const reason = PolicyDecision.reason(postTurnDecision, "stop");
    if (effectOf(postTurnDecision, "run.abort")) {
      const event = createStreamCompleteEvent(state, {
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
  const event = createStreamCompleteEvent(state, { finishReason: "stop" });
  yield event;
  return flowDecision({ kind: "complete", event });
}

export async function* handleContinue(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  turnUsage: TokenUsage,
): AsyncGenerator<AgentEvent, "continue"> {
  emitTurnComplete(state, config, agentBase, turnUsage);
  yield { type: "turn_complete", turnIndex: state.turnIndex, usage: turnUsage };
  advanceStreamTurn(state);
  return continueFlowDecision(continueDecision(state));
}

export async function handleCompact(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): Promise<"continue" | AgentEvent> {
  const blocked = await applyPostCompaction(state, engine, config, agentBase, false);
  if (blocked) return blocked;
  advanceStreamTurn(state);
  return continueFlowDecision(continueDecision(state));
}

export async function* handleError(
  state: StreamRunState,
  engine: PolicyEngineInstance,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  error: unknown,
  attempt: number,
  retryPolicy: Parameters<typeof Retry.shouldRetry>[0],
): AsyncGenerator<AgentEvent, ErrorDecision> {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const onErrorDecision = await engine.dispatch(
    "error",
    buildLifecyclePolicyContext(state, config, {
      toolInput: { error: normalizedError },
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
    yield createStreamErrorEvent(normalizedError, true);
    await Retry.sleep(backoffMs, config.signal);
    return { action: "retry", kind: "error", error: normalizedError, errorMessage: lastError };
  }

  emitRunFailed(agentBase, lastError);
  yield createStreamErrorEvent(normalizedError, false);
  return { action: "throw", kind: "error", error: normalizedError, errorMessage: lastError };
}

function continueDecision(state: StreamRunState): Extract<TurnDecision, { kind: "continue" }> {
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
