import { executionReads } from "./execution-reads";
import { fencedTurnFixture } from "./fenced-writer";
import { isolatedLedger } from "./isolated";
import { Effect } from "effect";
import type { LedgerAction } from "@openomni/protocol";
import type { SessionKernel } from "../../src/cluster/kernel-registry";
import type { ExecutionLedger } from "../../src/executor";

export function requestLedger(input: {
  readonly id: string;
  readonly clock?: () => number;
  readonly kernel?: SessionKernel;
}) {
  return Effect.gen(function* () {
    const kernel = input.kernel ?? isolatedLedger().kernel;
    const { id } = input;
    const clock = input.clock ?? (() => 100);
    const { owner, fence, generation, turnId } = yield* fencedTurnFixture(kernel, { id, clock });
    const ledger: ExecutionLedger = {
      ...executionReads(kernel, id),
      commit: (action: LedgerAction.Append) =>
        Effect.gen(function* () {
          const row = kernel.row(id);
          const committed = yield* kernel.commit({
            sessionId: id,
            owner,
            fence,
            now: clock(),
            expectedRevision: row.revision,
            actions: [action],
            state: row.state,
          });
          const receipt = committed.receipts[0];
          if (receipt === undefined) throw new Error("test receipt missing");
          return receipt;
        }),
    };
    return {
      ledger,
      identity: {
        sessionId: id,
        role: "resident" as const,
        parentActionId: turnId,
        turnId,
        toolsGeneration: generation.generation,
        toolsHash: generation.toolsHash,
        systemHash: generation.systemHash,
      },
    };
  });
}
