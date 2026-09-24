import { executionReads } from "./execution-reads";
import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import { Effect } from "effect";
import { SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction } from "@openomni/protocol";
import type { ExecutionLedger } from "../../src/executor";

export function requestLedger(input: { readonly id: string; readonly clock?: () => number }) {
  return Effect.gen(function* () {
    const { id } = input;
    const clock = input.clock ?? (() => 100);
    const created = yield* SessionHandleStore.materialize({
      id,
      role: "resident",
      parentId: null,
      policyGeneration: 1,
      tools: [],
      system: { preset: "", blocks: [] },
      actionId: `${id}:configure`,
      at: clock(),
    });
    const owner = `${id}:owner`;
    const lease = yield* SessionHandleStore.acquireLease({
      sessionId: id,
      owner,
      expectedFence: created.row.leaseFence,
      now: clock(),
      expiresAt: clock() + 30_000,
    });
    const generation = SessionHandleStore.latestGeneration(sessionTree(id));
    const turnId = `${id}:turn`;
    const ledger: ExecutionLedger = {
      ...executionReads(id),
      commit: (action: LedgerAction.Append) =>
        Effect.gen(function* () {
          const row = SessionHandleStore.row(id);
          const committed = yield* SessionHandleStore.commit({
            sessionId: id,
            owner,
            fence: lease.fence,
            now: clock(),
            expectedRevision: row.revision,
            actions: [action],
            consumeInboxIds: [],
            state: row.state,
            releaseLease: false,
          });
          const receipt = committed.receipts[0];
          if (receipt === undefined) throw new Error("test receipt missing");
          return receipt;
        }),
    };
    yield* SessionHandleStore.commit({
      sessionId: id,
      owner,
      fence: lease.fence,
      now: clock(),
      expectedRevision: created.row.revision,
      consumeInboxIds: [],
      state: "running",
      releaseLease: false,
      actions: [
        {
          id: turnId,
          sessionId: id,
          parentId: `${id}:configure`,
          kind: "turn",
          intent: {
            encodingVersion: 1,
            value: {
              phase: "intent",
              resultId: `${id}:result`,
              inboxIds: [],
              resumeCount: 0,
              boundaryActionId: null,
              toolsGeneration: generation.generation,
              toolsHash: generation.toolsHash,
              systemHash: generation.systemHash,
              policyGeneration: 1,
            },
          },
          effect: { encodingVersion: 1, value: { phase: "pending" } },
          ts: clock(),
          irreversible: true,
        },
      ],
    });
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
