import { Effect } from "effect";
import { messageDecisionRules } from "./message-decision";
import { createExecutor, Bus, CommitFailed, type ExecutionError } from "@openomni/agent";
import { CorruptRecord, SessionHandleStore } from "@openomni/ledger";
import { compilePolicySnapshot } from "@openomni/policy";
import { LedgerAction, type PlainValue } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";

type ExecutionResult = Effect.Effect.Success<ReturnType<ReturnType<typeof createExecutor>["run"]>>;
type Run = Parameters<typeof createGatewayRouter>[0]["run"];
type NativeRun = (sender: Parameters<Run>[0], request: Parameters<Run>[1], body: (intent: LedgerAction.Receipt) => Effect.Effect<PlainValue, ExecutionError>) => Effect.Effect<ExecutionResult & { readonly matchedRuleIds: readonly string[] }, ExecutionError>;

/** External authentication has no active model turn; its message actions have one fenced owner. */
export function createIngressExecutor(clock: () => number): Effect.Effect<NativeRun, ExecutionError> {
  return Effect.gen(function* () {
    const id = "gateway-ingress";
    yield* SessionHandleStore.materialize({
      id, parentId: null, role: "resident", tools: [], system: { preset: "", blocks: [] },
      policyGeneration: SessionHandleStore.currentPolicyGeneration(), actionId: crypto.randomUUID(), at: clock(),
    }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
    const serial = yield* Effect.makeSemaphore(1);
    return (_sender, request, body) => serial.withPermits(1)(Effect.gen(function* () {
      const row = SessionHandleStore.row(id);
      const owner = crypto.randomUUID();
      const lease = yield* SessionHandleStore.acquireLease({
        sessionId: id, owner, expectedFence: row.leaseFence, now: clock(), expiresAt: clock() + SessionHandleStore.LEASE_TTL_MS,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      const commit = (actions: Parameters<typeof SessionHandleStore.commit>[0]["actions"], releaseLease: boolean) => Effect.suspend(() => SessionHandleStore.commit({
        sessionId: id, owner, fence: lease.fence, now: clock(), expectedRevision: SessionHandleStore.row(id).revision,
        actions: [...actions], consumeInboxIds: [], state: "idle", releaseLease,
      }));
      const executor = createExecutor({
        identity: { sessionId: id, role: "resident", parentActionId: null },
        policy: compilePolicySnapshot({ rows: SessionHandleStore.policyRows(row.policyGeneration), generation: row.policyGeneration, kinds: LedgerAction.Kind.options }),
        ledger: { commit: (action) => commit([action], false).pipe(Effect.flatMap((result) => {
          const receipt = result.receipts[0];
          return receipt === undefined
            ? Effect.fail(new CorruptRecord({ operation: "gateway.commit", id: action.id }))
            : Effect.succeed(receipt);
        })) },
        observations: Bus, clock, entropy: () => crypto.randomUUID(),
      });
      return yield* executor.run(request, body).pipe(
        Effect.map((result) => ({ ...result, matchedRuleIds: messageDecisionRules(id, request) })),
        Effect.ensuring(commit([], true).pipe(Effect.orDie)),
      );
    }));
  });
}
