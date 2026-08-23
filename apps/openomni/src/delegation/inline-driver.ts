import type { Delegation } from "@openomni/protocol";
import type { Admitted, DelegationOrigin } from "./admission";
import type { DelegationDriver, DriverOutcome } from "./kernel";

/**
 * Runs one worker turn and returns what it produced. Injected so the driver
 * owns delegation shape rather than agent construction — the app already
 * knows how to build a loop, and the driver should not learn that twice.
 */
export type InlineWorkerRunner = (
  input: {
    readonly delegationId: string;
    readonly instruction: string;
    readonly acceptanceCriteria: readonly string[];
    /**
     * Who this child runs as. Carried whole from admission rather than rebuilt
     * downstream, so neither the role nor the depth is decided twice — the cap
     * cannot be reset by the act of descending, and nothing else gets to
     * declare that a delegated child is a worker.
     */
    readonly origin: DelegationOrigin;
    readonly signal: AbortSignal;
  },
) => Promise<string>;

/**
 * The inline transport: a child loop in this process, with its own session.
 * "Same-domain, context-sharing" means it inherits the instruction and the
 * criteria — not the parent's transcript, which stays private to the parent.
 */
export function createInlineDriver(run: InlineWorkerRunner): DelegationDriver {
  return {
    async run(admitted: Admitted, handle: Delegation.Handle, signal: AbortSignal): Promise<DriverOutcome> {
      const output = await run({
        delegationId: handle.delegationId,
        instruction: admitted.request.payload.text,
        acceptanceCriteria: admitted.request.acceptanceCriteria ?? [],
        origin: admitted.childOrigin,
        signal,
      });

      // The kernel aborts on deadline and settles no_response itself. A child
      // that notices the abort and returns anyway must not be reported as a
      // completion the parent can act on.
      if (signal.aborted) return { status: "cancelled", reason: "deadline reached" };

      return { status: "completed", output };
    },
  };
}
