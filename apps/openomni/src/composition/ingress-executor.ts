import { Effect } from "effect";
import { messageDecisionRules } from "./message-decision";
import { createExecutor, BundleDefinitions, Clock, Entropy, GenerationLayers, CommitFailed, ForeignFailure, type ExecutionError, type SessionEntryServices } from "@openomni/agent";
import { CorruptRecord, SessionHandleStore } from "@openomni/ledger";
import type { LedgerAction, PlainValue } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";

type ExecutionResult = Effect.Effect.Success<ReturnType<Effect.Effect.Success<ReturnType<typeof createExecutor>>["run"]>>;
type Run = Parameters<typeof createGatewayRouter>[0]["run"];
type NativeRun = (sender: Parameters<Run>[0], request: Parameters<Run>[1], body: (intent: LedgerAction.Receipt) => Effect.Effect<PlainValue, ExecutionError>) => Effect.Effect<ExecutionResult & { readonly matchedRuleIds: readonly string[] }, ExecutionError>;

/** External authentication has no active model turn; its message actions have one fenced owner. */
export function createIngressExecutor(): Effect.Effect<NativeRun, ExecutionError, SessionEntryServices | BundleDefinitions> {
  return Effect.gen(function* () {
    const id = "gateway-ingress";
    const services = yield* Effect.context<SessionEntryServices>();
    const generations = yield* GenerationLayers;
    const { now: clock } = yield* Clock;
    const { next } = yield* Entropy;
    const installed = yield* BundleDefinitions;
    yield* SessionHandleStore.materialize({
      id, parentId: null, role: "resident", tools: [], bundles: installed.names, system: { preset: "", blocks: [] },
      policyGeneration: SessionHandleStore.currentPolicyGeneration(), actionId: crypto.randomUUID(), at: clock(),
    }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
    const serial = yield* Effect.makeSemaphore(1);
    return (_sender, request, body) => serial.withPermits(1)(Effect.scoped(Effect.gen(function* () {
      const row = SessionHandleStore.row(id);
      const owner = next();
      const captured = yield* generations.capture({ sessionId: id, generation: row.toolsGeneration }).pipe(Effect.mapError((error) => new ForeignFailure({ operation: "ingress.capture", cause: String(error) })));
      const lease = yield* SessionHandleStore.acquireLease({
        sessionId: id, owner, expectedFence: row.leaseFence, now: clock(), expiresAt: clock() + SessionHandleStore.LEASE_TTL_MS,
      }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
      const commit = (actions: Parameters<typeof SessionHandleStore.commit>[0]["actions"], releaseLease: boolean) => Effect.suspend(() => SessionHandleStore.commit({
        sessionId: id, owner, fence: lease.fence, now: clock(), expectedRevision: SessionHandleStore.row(id).revision,
        actions: [...actions], consumeInboxIds: [], state: "idle", releaseLease,
      }));
      const work = Effect.gen(function* () {
      const executor = yield* createExecutor({
        identity: { sessionId: id, role: "resident", parentActionId: null },
        ledger: { commit: (action) => commit([action], false).pipe(Effect.flatMap((result) => {
          const receipt = result.receipts[0];
          return receipt === undefined
            ? Effect.fail(new CorruptRecord({ operation: "gateway.commit", id: action.id }))
            : Effect.succeed(receipt);
        })) },
      });
      return yield* executor.run(request, body).pipe(
        Effect.map((result) => ({ ...result, matchedRuleIds: messageDecisionRules(id, request) })),
        Effect.ensuring(commit([], true).pipe(Effect.orDie)),
      );
      });
      return yield* captured.provide(work).pipe(Effect.provide(services));
    })));
  });
}
