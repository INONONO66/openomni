import type { Delegation } from "@openomni/protocol";
import type { Admitted, DelegationOrigin } from "./admission";
import type { DelegationDriver, DriverOutcome, DriverReport } from "./kernel";
import { WorkerRunError } from "../composition/worker-session";

/** Runs one isolated in-process worker turn. */
export type InlineWorkerRunner = (input: {
  readonly delegationId: string;
  /** Run identity allocated before commissioning, when this is an assigned worker. */
  readonly workerRunId?: string;
  readonly operation: Delegation.Operation;
  readonly instruction: string;
  readonly acceptanceCriteria: readonly string[];
  /** Admission-stamped worker identity and delegation lineage. */
  readonly origin: DelegationOrigin;
  readonly signal: AbortSignal;
}) => Promise<{ readonly text: string; readonly tokens: number; readonly runId?: string }>;

/**
 * The volatile inline transport. The kernel still records it before this runs,
 * but the calling tool awaits its settlement in the same turn.
 */
export function createInlineDriver(run: InlineWorkerRunner): DelegationDriver {
  return {
    run: async (
      admitted: Admitted,
      handle: Delegation.Handle,
      signal: AbortSignal,
      report?: DriverReport,
    ): Promise<DriverOutcome> => {
      if (signal.aborted) return { status: "cancelled", reason: "delegation stopped" };
      report?.delivered();
      let output: Awaited<ReturnType<InlineWorkerRunner>>;
      const input = {
        delegationId: handle.delegationId,
        ...(admitted.workerRunId === undefined ? {} : { workerRunId: admitted.workerRunId }),
        operation: admitted.request.operation,
        instruction: admitted.request.payload.text,
        acceptanceCriteria: admitted.request.acceptanceCriteria ?? [],
        origin: admitted.childOrigin,
        signal,
      };
      try {
        output = await run(input);
      } catch (error) {
        if (error instanceof WorkerRunError)
          return { status: "failed", error: error.message, workerRunId: error.runId };
        throw error;
      }

      // A completion racing after cancellation/deadline cannot replace the
      // kernel's terminal CAS. Reporting cancelled also avoids presenting it
      // as usable output to a caller whose inline turn is still unwinding.
      if (signal.aborted) return { status: "cancelled", reason: "delegation stopped" };
      return {
        status: "completed",
        output: output.text,
        ...(output.runId === undefined ? {} : { workerRunId: output.runId }),
        usage: { tokens: output.tokens },
      };
    },
  };
}
