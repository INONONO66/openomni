import { Run } from "@openomni/llm";

/**
 * The loop's retry policy. `retryOn` uses the same closed reason vocabulary
 * as the retry event record.
 */
export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: {
    initial: number;
    multiplier: number;
    max: number;
  };
  retryOn?: RetryReason[];
}

export type RetryReason =
  | "timeout"
  | "tool_error"
  | "transient_error"
  | "validation_error"
  | "context_overflow";

/**
 * What a terminal record may report. `aborted` is not a {@link RetryReason}:
 * an abort is an instruction to stop, never a fault to classify as retryable,
 * so it can appear on `agent.run.failed` but never on `agent.error.retry`.
 */
export type TerminalReason = RetryReason | "aborted";

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: { initial: 1000, multiplier: 2, max: 30_000 },
  retryOn: ["timeout", "tool_error", "transient_error"],
};

export function calculateBackoffMs(policy: RetryPolicy, attempt: number): number {
  const rawDelay =
    policy.backoffMs.initial * policy.backoffMs.multiplier ** Math.max(0, attempt - 1);
  return Math.min(rawDelay, policy.backoffMs.max);
}

/**
 * Aborts are NOT classified here (#audit M4): "aborted" as a message
 * substring used to map to the retryable "timeout", so an abort mid-run
 * emitted a retry promise and then died in `Retry.sleep` — and a tool error
 * that merely mentioned "aborted" triggered a bogus retry. Abort is decided
 * by identity ({@link isAbort}: signal state or the typed error), before any
 * message classification runs. Likewise "budget exceeded" matched here for a
 * condition that never throws — budget exhaustion ends the run with a
 * result, not an error.
 *
 */
export function classifyRetryReason(errorMessage: string): RetryReason {
  const normalized = errorMessage.toLowerCase();
  if (normalized.includes("timeout")) {
    return "timeout";
  }
  if (normalized.includes("tool")) {
    return "tool_error";
  }
  if (normalized.includes("validation")) {
    return "validation_error";
  }
  return "transient_error";
}

/**
 * Provider context-overflow, decided by message text (compaction-design L5;
 * pattern list adopted from pss-runtime's loop-overflow classifier). Checked
 * BEFORE the generic classification: an overflow is recoverable exactly once
 * per run by re-entering the compaction seam, never by blind retry — the
 * same prompt fails the same way.
 */
export function isContextOverflow(error: Error): boolean {
  const failure = asLlmFailure(error);
  if (failure !== undefined) return failure.data.contextOverflow;
  const normalized = error.message.toLowerCase();
  return (
    normalized.includes("context_length_exceeded") ||
    normalized.includes("context length") ||
    normalized.includes("context limit") ||
    normalized.includes("context window") ||
    normalized.includes("maximum context") ||
    normalized.includes("prompt is too long") ||
    normalized.includes("too many tokens") ||
    normalized.includes("token limit") ||
    // Gemini: "The input token count (N) exceeds the maximum number of
    // tokens allowed (M)."; Bedrock-Anthropic: "Input is too long for
    // requested model." (#726 review F3)
    normalized.includes("exceeds the maximum number of tokens") ||
    normalized.includes("input is too long")
  );
}

/**
 * The typed abort the loop throws when it observes its own signal. The name
 * is the identity {@link isAbort} checks — never the message, which tool and
 * provider errors are free to collide with.
 */
export function abortError(message = "aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * Whether this failure is the run being told to stop. Decided by the
 * config's signal state or the typed error identity — never by message
 * substrings. An abort is non-retryable and must not emit retry-promising
 * telemetry (#audit M4).
 */
export function isAbort(error: Error, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    error.name === "AbortError" ||
    asLlmFailure(error)?.data.aborted === true
  );
}

function asLlmFailure(error: Error): Run.Failure | undefined {
  return Run.FailureError.isInstance(error as unknown) ? (error as Run.Failure) : undefined;
}

/**
 * What the run decided about the failure it is about to raise: the classified
 * reason, how many attempts were spent, and the ceiling they were spent
 * against. The loop already owns these facts for its terminal record; a host
 * that has to TELL someone why the turn produced nothing needs the same ones,
 * and re-deriving them from the error message is exactly the string matching
 * the closed vocabulary exists to avoid.
 */
export interface AgentFailureFacts {
  readonly reason: TerminalReason;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/**
 * Carried on the error object itself rather than by wrapping it: wrapping
 * would change the identity and message every existing catcher already reads.
 * The symbol keeps the facts off enumeration (JSON, logging, structured
 * clone) so nothing serializes them by accident.
 */
const FAILURE_FACTS = Symbol.for("openomni.agent.failureFacts");

/** Stamps the decided facts onto the error the run is raising. */
export function attachFailureFacts(error: Error, facts: AgentFailureFacts): void {
  Object.defineProperty(error, FAILURE_FACTS, {
    value: facts,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * The facts the run decided for this error, or undefined when it did not come
 * from an agent run (or died before any decision was reached). Absent is a
 * real answer: a host must not invent an attempt count.
 */
export function failureFacts(error: unknown): AgentFailureFacts | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const carried = (error as Record<symbol, unknown>)[FAILURE_FACTS];
  return carried === undefined ? undefined : (carried as AgentFailureFacts);
}

/**
 * Whether this attempt may be retried. An empty or absent `retryOn` means no
 * filter, so every reason is retryable up to `maxAttempts`.
 */
export function shouldRetry(policy: RetryPolicy, reason: RetryReason, attempt: number): boolean {
  if (attempt >= policy.maxAttempts) return false;
  if (policy.retryOn === undefined || policy.retryOn.length === 0) return true;
  return policy.retryOn.includes(reason);
}
