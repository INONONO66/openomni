import type { Model } from "@openomni/protocol";

/**
 * Placement — the ring-1 pure target-selection package
 * (docs/architecture.md § Outbound target selection; opened by #752 with its
 * smallest honest slice: the MODEL axis).
 *
 * A PURE fold in the protocol-fold discipline: no clock, no store, no I/O —
 * the candidate chain and the failure history are inputs, so every selection
 * is deterministic and replayable. Placement decides placement only: policy
 * alone owns allow/deny, the retry policy alone owns when a run stops
 * retrying, and the selection result is consumed as an input by the caller
 * (the agent loop's per-attempt model resolution).
 */
export namespace Placement {
  /**
   * The failure classes that advance a fallback chain to the next candidate.
   * Vocabulary: the agent loop's terminal-reason strings (`TerminalReason` in
   * `@openomni/agent` — placement deliberately does not import the loop, so
   * the coupling is by declared string, pinned by tests on both sides).
   *
   * - `timeout` / `transient_error`: the provider/model failed or throttled —
   *   the next candidate is the point of a fallback chain.
   * - `validation_error`: the model produced an unusable shape or refused —
   *   model-specific, so the chain advances.
   *
   * Deliberately NOT advancing:
   * - `tool_error`: the tool failed, not the model — switching models would
   *   discard a working candidate for someone else's fault.
   * - `context_overflow`: owned by the compaction recovery seam (L5), which
   *   retries the SAME model against a reclaimed window; advancing here would
   *   fight that recovery.
   * - `aborted`: the run being told to stop is never a placement signal.
   * - unknown strings: fail conservative — stay on the current candidate.
   */
  export const ADVANCING_FAILURES: ReadonlySet<string> = new Set([
    "timeout",
    "transient_error",
    "validation_error",
  ]);

  export interface ModelSelection {
    readonly model: Model.Ref;
    /** Index into the chain that was selected (0 = primary). */
    readonly index: number;
    /**
     * True when the failure history had already advanced past the last
     * candidate — the selection is clamped to the final one. Termination
     * stays the retry policy's decision; placement only reports that it has
     * nothing further to offer.
     */
    readonly exhausted: boolean;
  }

  /**
   * Selects the model for the next attempt from an ordered candidate chain.
   *
   * The index is the count of chain-advancing failures in the history,
   * clamped to the last candidate. Time is not an input; the same
   * `(chain, history)` always yields the same selection.
   *
   * @param chain ordered candidates, primary first — must be non-empty
   * @param priorFailureReasons the reasons of every FINISHED attempt so far,
   *   oldest first (the loop's decided facts, never re-derived)
   */
  export function selectModel(
    chain: readonly Model.Ref[],
    priorFailureReasons: readonly string[],
  ): ModelSelection {
    const primary = chain[0];
    if (primary === undefined) {
      throw new TypeError("placement requires a non-empty model chain");
    }
    const advances = priorFailureReasons.filter((reason) => ADVANCING_FAILURES.has(reason)).length;
    const lastIndex = chain.length - 1;
    const index = Math.min(advances, lastIndex);
    // chain[index] is present by construction: 0 <= index <= lastIndex.
    return {
      model: chain[index] as Model.Ref,
      index,
      exhausted: advances > lastIndex,
    };
  }
}
