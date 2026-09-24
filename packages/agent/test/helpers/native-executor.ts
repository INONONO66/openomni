import { executionReads } from "./execution-reads";
import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import type { ResolvedExecutorOptions } from "../../src/executor-contract";
import { KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import { SessionHandleStore } from "@openomni/ledger";
import { compilePolicySnapshot, SEEDED_POLICY_ROWS } from "@openomni/policy";
import { type LedgerAction, PlainObjectSchema } from "@openomni/protocol";
import { Effect } from "effect";
import type { ExecutionLedger, } from "../../src/executor-contract";

export const fiberSessionId = "fiber-session";
export const nativePolicy = compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY,
  generation: 1,
  rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
});
export const effectValue = (action: LedgerAction.Append) => PlainObjectSchema.parse(action.effect.value);

export function nativeExecutorOptions(now = 100, id = fiberSessionId) {
  return Effect.gen(function* () {
    const initial = yield* SessionHandleStore.materialize({
      id, parentId: null, role: "resident", tools: [], system: { preset: "A", blocks: [] },
      policyGeneration: 1, actionId: `${id}:configure`, at: now,
    });
    const owner = `owner:${now}`;
    const lease = yield* SessionHandleStore.acquireLease({
      sessionId: id, owner, expectedFence: initial.row.leaseFence,
      now, expiresAt: now + SessionHandleStore.LEASE_TTL_MS,
    });
    const turnId = `${id}:turn`;
    const ledger: ExecutionLedger = {
      ...executionReads(id),
      commit: (action) => Effect.suspend(() => SessionHandleStore.commit({
        sessionId: id, owner, fence: lease.fence, now,
        expectedRevision: SessionHandleStore.row(id).revision,
        actions: [action], consumeInboxIds: [], state: "running", releaseLease: false,
      })).pipe(Effect.map((result) => {
        const receipt = result.receipts[0];
        if (receipt === undefined) throw new Error("missing action receipt");
        return receipt;
      })),
    };
    if (!sessionTree(id).some((action) => action.id === turnId)) {
      const generation = SessionHandleStore.latestGeneration(sessionTree(id));
      yield* ledger.commit({
        id: turnId, parentId: `${id}:configure`, sessionId: id, kind: "turn",
        intent: { encodingVersion: 1, value: {
          phase: "intent", resultId: `${id}:result`, inboxIds: [], resumeCount: 0,
          boundaryActionId: null, toolsGeneration: generation.generation,
          toolsHash: generation.toolsHash, systemHash: generation.systemHash, policyGeneration: 1,
        } },
        effect: { encodingVersion: 1, value: { phase: "pending" } }, ts: now, irreversible: true,
      });
    }
    let sequence = SessionHandleStore.row(id).revision;
    return {
      policy: nativePolicy, ledger, observations: { publish: () => undefined },
      clock: () => now, entropy: () => `${id}:${now}:${++sequence}`,
      identity: { sessionId: id, role: "resident", parentActionId: turnId, turnId },
    } satisfies ResolvedExecutorOptions;
  });
}
