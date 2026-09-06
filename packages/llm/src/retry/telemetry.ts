import { LlmCall, Operational, type BusEvent } from "@openomni/protocol";
import type { Retry } from "./index";

/** Provider retry facts are emitted only after the executor decides to schedule another attempt. */
export function observeRetry(
  events: BusEvent.Sink,
  input: {
    readonly traceId: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly provider: string;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly decision: Extract<Retry.Decision, { retry: true }>;
  },
): void {
  const { decision } = input;
  events.publish(LlmCall.Events.RetryDecided, {
    traceId: input.traceId,
    sessionId: input.sessionId,
    runId: input.runId,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    reason: decision.reason,
    backoffMs: decision.delayMs,
    time: Date.now(),
  });
  if (decision.reason === "rate_limit")
    events.publish(LlmCall.Events.RateLimited, {
      traceId: input.traceId,
      sessionId: input.sessionId,
      runId: input.runId,
      provider: input.provider,
      retryAfterMs: decision.delayMs,
      time: Date.now(),
    });
  if (decision.retryAfterOverCap)
    events.publish(Operational.Events.Warn, {
      traceId: input.traceId,
      sessionId: input.sessionId,
      component: "llm.retry",
      time: Date.now(),
      msg: "ratelimit reset above cap; demoted to backoff",
      context: { backoffMs: decision.delayMs },
    });
}
