import { AgentExecution, Operational, PolicyDecision } from "@openomni/protocol";
import type { BusEvent, Policy, TraceContext } from "@openomni/protocol";
import type { RetryReason } from "../retry";
import type { AgentResult, AgentStep, TokenUsage } from "../types";
import { getCompactionCount, type AgentRunBase, type RunState } from "./run-state";

export function emitRunStarted(
  events: BusEvent.Sink,
  trace: TraceContext.Type,
  modelId: string,
): void {
  events.publish(Operational.Info, {
    traceId: trace.traceId,
    time: Date.now(),
    sessionId: trace.sessionId,
    component: "agent",
    msg: "agent.run.started",
    context: { model: modelId },
  });
}

export function emitTurnStart(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
): void {
  const turnIndex = state.turnIndex;
  const sessionId = agentBase.sessionId;
  events.publish(AgentExecution.TurnStart, {
    ...agentBase,
    sessionId,
    time: Date.now(),
    turnIndex,
  });
}

export function emitTurnComplete(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
): void {
  const sessionId = agentBase.sessionId;
  events.publish(AgentExecution.TurnComplete, {
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
  events: BusEvent.Sink,
  agentBase: AgentRunBase,
  remaining: string,
  threshold: number,
): void {
  events.publish(AgentExecution.BudgetReassurance, {
    ...agentBase,
    time: Date.now(),
    remaining,
    threshold,
  });
}

export function emitBudgetWarning(
  events: BusEvent.Sink,
  agentBase: AgentRunBase,
  remaining: string,
  threshold: number,
): void {
  events.publish(AgentExecution.BudgetWarning, {
    ...agentBase,
    time: Date.now(),
    remaining,
    threshold,
  });
}

export function emitRunCompleted(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  finishReason: "stop" | "max-steps",
): void {
  events.publish(Operational.Info, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId,
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
  events: BusEvent.Sink,
  agentBase: AgentRunBase,
  options: {
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly error: string;
    readonly reason: RetryReason;
    readonly backoffMs: number;
  },
): void {
  const sessionId = agentBase.sessionId;
  events.publish(AgentExecution.ErrorRetry, {
    ...agentBase,
    sessionId,
    time: Date.now(),
    attempt: options.attempt,
    maxAttempts: options.maxAttempts,
    error: options.error,
    reason: options.reason,
    backoffMs: options.backoffMs,
  });
}

/**
 * The run is over and will not be retried.
 *
 * `reason` and `maxAttempts` are carried because on a first-attempt terminal
 * failure no `ErrorRetry` precedes this, and the effective `maxAttempts` — the
 * configured one narrowed by a `run.retry_after` effect — exists nowhere else
 * in the record.
 */
export function emitRunFailed(
  events: BusEvent.Sink,
  agentBase: AgentRunBase,
  error: string,
  decision: {
    readonly reason: RetryReason;
    readonly attempt: number;
    readonly maxAttempts: number;
  },
): void {
  events.publish(Operational.Error, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId,
    component: "agent",
    msg: "agent.run.failed",
    error,
    context: { ...decision },
  });
}

export function emitCompaction(
  events: BusEvent.Sink,
  agentBase: AgentRunBase,
  messagesBefore: number,
  messagesAfter: number,
): void {
  events.publish(AgentExecution.Compaction, {
    ...agentBase,
    time: Date.now(),
    messagesBefore,
    messagesAfter,
  });
}

export function publishDenyDiagnostic(
  events: BusEvent.Sink,
  timing: Policy.Timing,
  decision: Policy.PolicyDecision,
  state: RunState,
  agentBase: AgentRunBase,
): void {
  const reason = PolicyDecision.reason(decision, "denied");
  const sessionId = agentBase.sessionId;
  events.publish(Operational.Info, {
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
}

export function guardAbortedResult(
  state: RunState,
  options?: { text?: string; steps?: AgentStep[]; finishReason?: "stop" | "stalled" },
): AgentResult {
  return runResult(state, { ...options, guardAborted: true });
}

export function runResult(
  state: RunState,
  options?: {
    text?: string;
    steps?: AgentStep[];
    finishReason?: "stop" | "stalled" | "max-steps";
    guardAborted?: boolean;
  },
): AgentResult {
  return {
    text: options?.text ?? state.lastAssistantText,
    steps: options?.steps ?? state.steps,
    usage: state.totalUsage,
    finishReason: options?.finishReason ?? "stop",
    ...(options?.guardAborted !== undefined && { guardAborted: options.guardAborted }),
    compactionCount: getCompactionCount(state),
  };
}
