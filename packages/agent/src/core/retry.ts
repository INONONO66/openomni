import { Run } from "@openomni/llm";

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
  /** True only when the terminal error came from an llm.run outcome. */
  readonly llm: true;
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
