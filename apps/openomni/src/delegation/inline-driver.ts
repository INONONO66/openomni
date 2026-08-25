import type { Delegation } from "@openomni/protocol";
import type { Admitted, DelegationOrigin } from "./admission";
import type { DelegationDriver, DriverOutcome, DriverReport } from "./kernel";

/** Runs one isolated in-process worker turn. */
export type InlineWorkerRunner = (
  input: {
    readonly delegationId: string;
    readonly instruction: string;
    readonly acceptanceCriteria: readonly string[];
    /** Admission-stamped worker identity and delegation lineage. */
    readonly origin: DelegationOrigin;
    readonly signal: AbortSignal;
  },
) => Promise<string>;

/**
 * The volatile inline transport. The kernel still records it before this runs,
 * but the calling tool awaits its settlement in the same turn.
 */
export function createInlineDriver(run: InlineWorkerRunner): DelegationDriver {
  return {
    async run(
      admitted: Admitted,
      handle: Delegation.Handle,
      signal: AbortSignal,
      report?: DriverReport,
    ): Promise<DriverOutcome> {
      if (signal.aborted) return { status: "cancelled", reason: "delegation stopped" };
      report?.delivered();
      const output = await run({
        delegationId: handle.delegationId,
        instruction: admitted.request.payload.text,
        acceptanceCriteria: admitted.request.acceptanceCriteria ?? [],
        origin: admitted.childOrigin,
        signal,
      });

      // A completion racing after cancellation/deadline cannot replace the
      // kernel's terminal CAS. Reporting cancelled also avoids presenting it
      // as usable output to a caller whose inline turn is still unwinding.
      if (signal.aborted) return { status: "cancelled", reason: "delegation stopped" };
      return { status: "completed", output };
    },
  };
}
