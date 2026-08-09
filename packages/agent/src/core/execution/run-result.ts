import type { AgentEvent, AgentStep } from "../types";
import { getCompactionCount, type RunState } from "./run-state";

export function createGuardCompleteEvent(
  state: RunState,
  options?: { text?: string; steps?: AgentStep[]; finishReason?: "stop" | "stalled" },
): AgentEvent {
  return createRunCompleteEvent(state, { ...options, guardAborted: true });
}

export function createRunCompleteEvent(
  state: RunState,
  options?: {
    text?: string;
    steps?: AgentStep[];
    finishReason?: "stop" | "stalled" | "max-steps";
    guardAborted?: boolean;
  },
): AgentEvent {
  return {
    type: "complete",
    result: {
      text: options?.text ?? state.lastAssistantText,
      steps: options?.steps ?? state.steps,
      usage: state.totalUsage,
      finishReason: options?.finishReason ?? "stop",
      ...(options?.guardAborted !== undefined && { guardAborted: options.guardAborted }),
      compactionCount: getCompactionCount(state),
    },
  };
}

export function createRunErrorEvent(error: Error, willRetry: boolean): AgentEvent {
  return {
    type: "error",
    error,
    willRetry,
  };
}
