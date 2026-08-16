import type { BusEvent } from "@openomni/protocol";
import type { EmitPayload } from "./trace";

/**
 * How a span ended.
 *
 * `guard_denied` and `budget_exhausted` are first-class because they are how a
 * run most often stops: without them a policy block looks like a normal return
 * and emits no terminal event at all — at the time this vocabulary was cut,
 * twelve of the agent's fifteen run-terminating paths did exactly that.
 * NOTE: `Emitter.span` has no production caller yet (D11 roadmap surface);
 * the vocabulary is ahead of its adoption.
 */
export type SpanOutcome =
  | { readonly kind: "completed" }
  | {
      readonly kind: "guard_denied";
      readonly point: string;
      readonly policyId: string;
      readonly reason: string;
    }
  | { readonly kind: "budget_exhausted"; readonly limit: string }
  | { readonly kind: "failed"; readonly error: Error };

/**
 * OpenTelemetry span status. `unset` is unreachable here — a span that ended
 * always knows whether the work it wrapped got done.
 *
 * A policy denial maps to `error`: the decision itself succeeded, but the
 * operation the span measures did not complete. The reason travels with the
 * outcome, so an exporter can distinguish a denial from a crash.
 */
export type SpanStatus = "ok" | "error";

export function spanStatus(outcome: SpanOutcome): SpanStatus {
  return outcome.kind === "completed" ? "ok" : "error";
}

/** A one-line description of why a span ended, for the status message. */
export function spanStatusMessage(outcome: SpanOutcome): string | undefined {
  switch (outcome.kind) {
    case "completed":
      return undefined;
    case "guard_denied":
      return `${outcome.point}: ${outcome.reason}`;
    case "budget_exhausted":
      return `budget exhausted: ${outcome.limit}`;
    case "failed":
      return outcome.error.message;
  }
}

/**
 * A start/end descriptor pair plus the mapping from outcome to terminal
 * payload. Holding both ends in one value is what lets the emitter guarantee
 * they are published together.
 */
export interface SpanPair<TStart, TEnd> {
  readonly start: BusEvent.Descriptor<TStart>;
  readonly end: BusEvent.Descriptor<TEnd>;
  readonly terminal: (outcome: SpanOutcome, elapsedMs: number) => EmitPayload<TEnd>;
}

export interface SpanHandle {
  /**
   * Records how the span ended. Optional: a span that returns without settling
   * ends as `completed`. Calling twice keeps the first outcome, so an inner
   * guard is not overwritten by an outer one on the way out.
   */
  settle(outcome: SpanOutcome): void;
}

export function createSpanHandle(): SpanHandle & { outcome(): SpanOutcome | undefined } {
  let settled: SpanOutcome | undefined;
  return {
    settle(outcome) {
      settled ??= outcome;
    },
    outcome: () => settled,
  };
}

export function failedOutcome(error: unknown): Extract<SpanOutcome, { kind: "failed" }> {
  return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
}
