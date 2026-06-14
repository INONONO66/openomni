import { AgentExecution, Operational, PolicyDecision } from "@openomni/protocol";
import type { Policy, TraceContext } from "@openomni/protocol";
import { Bus } from "@openomni/session";
import type { ChatAgentConfig, TokenUsage } from "../types";
import type { StreamAgentBase, StreamRunState } from "./stream-state";

export function emitRunStarted(trace: TraceContext.Type, modelId: string): void {
  Bus.publish(Operational.Info, {
    traceId: trace.traceId,
    time: Date.now(),
    sessionId: trace.sessionId,
    component: "agent",
    msg: "agent.run.started",
    context: { model: modelId },
  });
}

export function emitTurnStart(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): void {
  const turnIndex = state.turnIndex;
  const sessionId = eventSessionId(state, agentBase);
  config.eventEmitter?.emit("agent.turn.start", {
    sessionId,
    time: Date.now(),
    turnIndex,
  });
  Bus.publish(AgentExecution.TurnStart, {
    ...agentBase,
    sessionId,
    time: Date.now(),
    turnIndex,
  });
}

export function emitTurnComplete(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  turnUsage: TokenUsage,
): void {
  const sessionId = eventSessionId(state, agentBase);
  config.eventEmitter?.emit("agent.turn.complete", {
    sessionId,
    time: Date.now(),
    turnIndex: state.turnIndex,
    usage: {
      inputTokens: turnUsage.inputTokens,
      outputTokens: turnUsage.outputTokens,
      totalTokens: turnUsage.totalTokens,
    },
  });
  Bus.publish(AgentExecution.TurnComplete, {
    ...agentBase,
    sessionId,
    time: Date.now(),
    turnIndex: state.turnIndex,
    usage: {
      inputTokens: turnUsage.inputTokens,
      outputTokens: turnUsage.outputTokens,
      totalTokens: turnUsage.totalTokens,
    },
  });
}

export function emitBudgetReassurance(
  agentBase: StreamAgentBase,
  remaining: string,
  threshold: number,
): void {
  Bus.publish(AgentExecution.BudgetReassurance, {
    ...agentBase,
    time: Date.now(),
    remaining,
    threshold,
  });
}

export function emitBudgetWarning(
  agentBase: StreamAgentBase,
  remaining: string,
  threshold: number,
): void {
  Bus.publish(AgentExecution.BudgetWarning, {
    ...agentBase,
    time: Date.now(),
    remaining,
    threshold,
  });
}

export function emitRunCompleted(
  state: StreamRunState,
  agentBase: StreamAgentBase,
  finishReason: "stop" | "max-steps",
): void {
  Bus.publish(Operational.Info, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId || undefined,
    component: "agent",
    msg: "agent.run.completed",
    context: {
      finishReason,
      turns: state.budgetState.turns,
      durationMs: Date.now() - state.startTime,
    },
  });
}

export function emitErrorRetry(
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
  options: { readonly attempt: number; readonly maxAttempts: number; readonly error: string },
): void {
  const sessionId = eventSessionId(state, agentBase);
  config.eventEmitter?.emit("agent.error.retry", {
    sessionId,
    time: Date.now(),
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    error: options.error,
  });
  Bus.publish(AgentExecution.ErrorRetry, {
    ...agentBase,
    sessionId,
    time: Date.now(),
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    error: options.error,
  });
}

export function emitRunFailed(agentBase: StreamAgentBase, error: string): void {
  Bus.publish(Operational.Error, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId || undefined,
    component: "agent",
    msg: "agent.run.failed",
    error,
  });
}

export function emitCompaction(
  agentBase: StreamAgentBase,
  messagesBefore: number,
  messagesAfter: number,
): void {
  Bus.publish(AgentExecution.Compaction, {
    ...agentBase,
    time: Date.now(),
    messagesBefore,
    messagesAfter,
  });
}

export function publishDenyDiagnostic(
  timing: Policy.Timing,
  decision: Policy.PolicyDecision,
  state: StreamRunState,
  config: ChatAgentConfig,
  agentBase: StreamAgentBase,
): void {
  const reason = PolicyDecision.reason(decision, "denied");
  const sessionId = diagnosticSessionId(state, agentBase);
  Bus.publish(Operational.Info, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId,
    component: "agent",
    msg: "agent.policy.deny.diagnostic",
    context: {
      timing,
      reason,
      policyId: decision.policyId,
      turns: state.budgetState.turns,
      elapsedMs: Date.now() - state.startTime,
    },
  });
  config.eventEmitter?.emit("agent.policy.deny", {
    sessionId,
    time: Date.now(),
    timing,
    reason,
    policyId: decision.policyId,
  });
}

function eventSessionId(state: StreamRunState, agentBase: StreamAgentBase): string {
  return agentBase.sessionId || state.sessionId;
}

function diagnosticSessionId(
  state: StreamRunState,
  agentBase: StreamAgentBase,
): string | undefined {
  const sessionId = eventSessionId(state, agentBase);
  return sessionId === "stream-engine" ? undefined : sessionId;
}
