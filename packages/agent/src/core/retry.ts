import { Run } from "@openomni/llm";
import { z } from "zod";

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

function asLlmFailure(error: Error): Pick<Run.Failure, "data"> | undefined {
  if (!Run.FailureError.isInstance(error)) return undefined;
  return Run.FailureError.Schema.parse(error);
}

/**
 * What the run decided about the failure it is about to raise: the classified
 * reason, how many attempts were spent, and the ceiling they were spent
 * against. The loop already owns these facts for its terminal record; a host
 * that has to TELL someone why the turn produced nothing needs the same ones,
 * and re-deriving them from the error message is exactly the string matching
 * the closed vocabulary exists to avoid.
 */
const AgentFailureFacts = z.object({
  reason: z.enum([
    "timeout",
    "tool_error",
    "transient_error",
    "validation_error",
    "context_overflow",
    "aborted",
  ]),
  attempt: z.number(),
  maxAttempts: z.number(),
  llm: z.literal(true),
});
type AgentFailureFacts = z.infer<typeof AgentFailureFacts>;

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
  const parsed = AgentFailureFacts.safeParse(Reflect.get(error, FAILURE_FACTS));
  return parsed.success ? parsed.data : undefined;
}
