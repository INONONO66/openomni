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
  now: () => number,
): void {
  events.publish(Operational.Events.Info, {
    traceId: trace.traceId,
    time: now(),
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
  now: () => number,
): void {
  events.publish(RunEvents.TurnStart, {
    ...agentBase,
    time: now(),
    turnIndex: state.turnIndex,
  });
}

export function emitTurnComplete(
  events: BusEvent.Sink,
  state: RunState,
  agentBase: AgentRunBase,
  turnUsage: TokenUsage,
  now: () => number,
): void {
  events.publish(RunEvents.TurnComplete, {
    ...agentBase,
    time: now(),
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
  now: () => number,
): void {
  const time = now();
  events.publish(Operational.Events.Info, {
    traceId: agentBase.traceId,
    time,
    sessionId: agentBase.sessionId,
    component: "agent",
    msg: "agent.run.completed",
    context: {
      finishReason,
      turns: state.budgetState.turns,
      durationMs: time - state.startTime,
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
  now: () => number,
): void {
  const sessionId = agentBase.sessionId;
  events.publish(RunEvents.ErrorRetry, {
    ...agentBase,
    sessionId,
    time: now(),
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
  now: () => number,
): void {
  events.publish(Operational.Events.Error, {
    traceId: agentBase.traceId,
    time: now(),
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
