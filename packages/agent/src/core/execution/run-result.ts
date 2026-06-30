import type { AgentEvent, AgentStep } from "../types";
import { getCompactionCount, type StreamRunState } from "./run-state";

export function createGuardCompleteEvent(
  state: StreamRunState,
  options?: { text?: string; steps?: AgentStep[]; finishReason?: "stop" | "stalled" },
): AgentEvent {
  return createStreamCompleteEvent(state, { ...options, guardAborted: true });
}

export function createStreamCompleteEvent(
  state: StreamRunState,
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

export function createStreamErrorEvent(error: Error, willRetry: boolean): AgentEvent {
  return {
    type: "error",
    error,
    willRetry,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
