import { Operational } from "@openomni/protocol";
import { RunEvents } from "./events";
import type { BusEvent, TraceContext } from "@openomni/protocol";
import type { RetryReason, TerminalReason } from "../retry";
import type { AgentResult, AgentStep, TokenUsage } from "../types";
import { getCompactionCount, type AgentRunBase, type RunState } from "./state";

export function emitRunStarted(
  events: BusEvent.Sink,
  trace: TraceContext.Type,
  modelId: string,
): void {
  events.publish(Operational.Events.Info, {
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
  events.publish(RunEvents.TurnStart, {
    ...agentBase,
    time: Date.now(),
    turnIndex: state.turnIndex,
  });
}

export function emitTurnComplete(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
): void {
  events.publish(RunEvents.TurnComplete, {
    ...agentBase,
    time: Date.now(),
    turnIndex: state.turnIndex,
    usage: {
      inputTokens: turnUsage.inputTokens,
      outputTokens: turnUsage.outputTokens,
      totalTokens: turnUsage.totalTokens,
    },
  });
}

export function emitRunCompleted(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  finishReason: AgentResult["finishReason"],
): void {
  events.publish(Operational.Events.Info, {
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
  events.publish(RunEvents.ErrorRetry, {
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
    readonly reason: TerminalReason;
    readonly attempt: number;
    readonly maxAttempts: number;
  },
): void {
  events.publish(Operational.Events.Error, {
    traceId: agentBase.traceId,
    time: Date.now(),
    sessionId: agentBase.sessionId,
    component: "agent",
    msg: "agent.run.failed",
    error,
    context: { ...decision },
  });
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
