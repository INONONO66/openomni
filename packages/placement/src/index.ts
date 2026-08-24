import type { Machine, Model, Tool } from "@openomni/protocol";

/**
 * Placement — the ring-1 pure target-selection package
 * (docs/architecture.md § Outbound target selection; opened by #752 with its
 * smallest honest slice: the MODEL axis, now joined by the MACHINE axis for
 * tool-catalog eligibility).
 *
 * PURE folds in the protocol-fold discipline: no clock, no store, no I/O —
 * candidates and their decided facts are inputs, so every selection is
 * deterministic and replayable. Placement decides placement only: policy
 * alone owns allow/deny, the retry policy alone owns when a run stops
 * retrying, and selection results are consumed as inputs by the caller (the
 * agent loop's per-attempt model resolution and tool-catalog assembly).
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
  export function selectModel(chain: readonly Model.Ref[], priorFailureReasons: readonly string[]) {
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

  /** A caller-supplied execution target and its already-folded capability set. */
  export type ToolTarget =
    | {
        readonly kind: "host";
        readonly capabilities: readonly Machine.CapabilityId[];
      }
    | {
        readonly kind: "machine";
        readonly id: Machine.MachineId;
        /** `Machine.effectiveCapabilities(...).capabilities`, never a raw offer. */
        readonly capabilities: readonly Machine.CapabilityId[];
      };

  export type ToolDecision = {
    readonly tool: Tool.Spec;
    readonly placement: Tool.Placement;
    readonly offerable: boolean;
  };

  /**
   * Resolves tool offerability against candidate targets.
   *
   * This is the single owner of the additive contract's absent placement:
   * an omitted `Tool.Spec.placement` means `free`. Every required capability
   * must be present in one candidate's effective set; requirements are never
   * pooled across candidates. The tool order remains the input catalog order.
   *
   * Total: an empty target list is ordinary placement state (nothing attached)
   * and folds to unofferable decisions rather than throwing.
   *
   * Offerability is the whole decision at this stage. WHICH eligible machine
   * executes a tool is named by the caller (a `run_code` cell takes a
   * `machineId`, discovered via the `machines` catalog tool) and is
   * deliberately absent here.
   */
  export function resolveTools(
    tools: readonly Tool.Spec[],
    targets: readonly ToolTarget[],
  ): readonly ToolDecision[] {
    return tools.map((tool): ToolDecision => {
      const placement = tool.placement ?? "free";
      const requires = tool.requires ?? [];
      const satisfies = (target: ToolTarget): boolean => {
        const effective = new Set(target.capabilities);
        return requires.every((capability) => effective.has(capability));
      };

      if (placement === "machine") {
        return {
          tool,
          placement,
          offerable: targets.some((target) => target.kind === "machine" && satisfies(target)),
        };
      }

      const eligibleTargets =
        placement === "host" ? targets.filter((target) => target.kind === "host") : targets;
      return {
        tool,
        placement,
        offerable: eligibleTargets.some(satisfies),
      };
    });
  }
}
