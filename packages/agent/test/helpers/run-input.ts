import { newSpanId, newTraceId } from "@openomni/telemetry";
import type { ChatAgentInput } from "../../src/core/types";

/**
 * A run input carrying a real identity.
 *
 * The runner refuses to mint one (#606). A run whose traceId, sessionId, and
 * runId were invented on its behalf emits events that correlate to nothing,
 * and the caller never learns it forgot — so tests state the identity the way
 * production does rather than leaning on a default.
 */
export function runInput(
  messages: ChatAgentInput["messages"],
  overrides: Omit<Partial<ChatAgentInput>, "messages"> = {},
): ChatAgentInput {
  return {
    messages,
    traceContext: {
      traceId: newTraceId(),
      sessionId: `session-${newSpanId()}`,
      runId: `run-${newSpanId()}`,
    },
    ...overrides,
  };
}
