import type { BusEvent } from "@openomni/protocol";
import { type Message, Operational, PolicyDecision } from "@openomni/protocol";
import { effectOf, PolicyEffectApplier } from "./policy-effects";
import { createAssistantMessage } from "../message-factory";
import * as Retry from "../retry";
import type { AgentResult, ChatAgentConfig, TokenUsage } from "../types";
import {
  guardAbortedResult,
  runResult,
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
} from "./run-state";
import type { PolicyEngineInstance } from "../policy";

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
  emitRunCompleted(config.events, state, agentBase, "stop");
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
      return {
        action: "complete",
        result: guardAbortedResult(state),
        errorMessage: normalizedError.message,
      };
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
    await Retry.sleep(backoffMs, config.signal);
    return { action: "retry", errorMessage: lastError };
  }

  emitRunFailed(config.events, agentBase, lastError, {
    reason: retryReason,
    attempt,
    maxAttempts: effectiveRetryPolicy.maxAttempts,
  });
  return { action: "throw", error: normalizedError, errorMessage: lastError };
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
    sessionId: agentBase.sessionId || state.sessionId,
    component: "agent.turn",
    msg: "llm sink emitted no assistant snapshot — test stub?",
  });
  const parentID = state.messages.at(-1)?.info.id ?? "";
  return createAssistantMessage("", parentID, state.sessionId);
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
