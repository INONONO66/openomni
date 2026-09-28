import { Effect, Semaphore } from "effect";
import { messageDecisionRules } from "./message-decision";
import { createExecutor, BundleDefinitions, Clock, Entropy, GenerationLayers, CommitFailed, ForeignFailure, type ExecutionError, type SessionEntryServices } from "@openomni/agent";
import { CorruptRecord, type LedgerError } from "@openomni/ledger";
import type { LedgerAction, PlainValue } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";
import type { AppLedgerPlane, SessionKernel } from "./cluster-runtime";

type ExecutionResult = Effect.Success<ReturnType<Effect.Success<ReturnType<typeof createExecutor>>["run"]>>;
type Run = Parameters<typeof createGatewayRouter>[0]["run"];
type NativeRun = (sender: Parameters<Run>[0], request: Parameters<Run>[1], body: (intent: LedgerAction.Receipt) => Effect.Effect<PlainValue, ExecutionError>) => Effect.Effect<ExecutionResult & { readonly matchedRuleIds: readonly string[] }, ExecutionError>;

/** The fixed perimeter session every external decision is recorded against. */
export const GATEWAY_INGRESS_SESSION = "gateway-ingress";

/**
 * Fence adoption for one out-of-turn writer (W5.2 F5): a strictly-newer CAS
 * on the session file; a lost single-increment race re-reads and re-decides.
 */
function adoptIngressAuthority(
  kernel: SessionKernel,
  sessionId: string,
  owner: string,
): Effect.Effect<number, LedgerError> {
  const attempt: Effect.Effect<number, LedgerError> = Effect.suspend(() => {
    const current = kernel.row(sessionId);
    if (current.leaseOwner === owner) return Effect.succeed(current.leaseFence);
    return kernel
      .adoptFence({ sessionId, owner, fence: current.leaseFence + 1 })
      .pipe(
        Effect.map((receipt) => receipt.fence),
        Effect.catchTag("LeaseRefused", () => attempt),
      );
  });
  return attempt;
}

/** External authentication has no active model turn; its message actions have one fenced owner. */
export function createIngressExecutor(plane: AppLedgerPlane): Effect.Effect<NativeRun, ExecutionError, SessionEntryServices | BundleDefinitions> {
  return Effect.gen(function* () {
    const id = GATEWAY_INGRESS_SESSION;
    const services = yield* Effect.context<SessionEntryServices>();
    const generations = yield* GenerationLayers;
    const { now: clock } = yield* Clock;
    const { next } = yield* Entropy;
    const installed = yield* BundleDefinitions;
    const kernel = plane.openKernel(id);
    yield* kernel.materialize({
      id, parentId: null, role: "resident", tools: [], bundles: installed.names, system: { preset: "", blocks: [] },
      policyGeneration: kernel.currentPolicyGeneration(), actionId: crypto.randomUUID(), at: clock(),
    }).pipe(Effect.mapError((error) => new CommitFailed({ error })));
    plane.catalog.indexSession({ id, parentId: null, role: "resident", createdAt: clock() });
    const serial = yield* Semaphore.make(1);
    return (_sender, request, body) => serial.withPermits(1)(Effect.scoped(Effect.gen(function* () {
      const row = kernel.row(id);
      const owner = next();
      console.error("PROBE ingress frame start", JSON.stringify({ kind: request.kind, op: request.op, owner }));
      yield* Effect.addFinalizer(() => Effect.sync(() => console.error("PROBE ingress frame end", owner)));
      const captured = yield* generations.capture({ sessionId: id, generation: row.toolsGeneration }).pipe(Effect.mapError((error) => new ForeignFailure({ operation: "ingress.capture", cause: String(error) })));
      const fence = yield* adoptIngressAuthority(kernel, id, owner).pipe(
        Effect.mapError((error) => new CommitFailed({ error })),
      );
      const commit = (actions: readonly LedgerAction.Append[]) => Effect.suspend(() => kernel.commit({
        sessionId: id, owner, fence, now: clock(), expectedRevision: kernel.row(id).revision,
        actions: [...actions], state: "idle",
      }));
      const work = Effect.gen(function* () {
      const executor = yield* createExecutor({
        identity: { sessionId: id, role: "resident", parentActionId: null },
        ledger: { commit: (action) => commit([action]).pipe(Effect.flatMap((result) => {
          const receipt = result.receipts[0];
          return receipt === undefined
            ? Effect.fail(new CorruptRecord({ operation: "gateway.commit", id: action.id }))
            : Effect.succeed(receipt);
        })) },
      });
      return yield* executor.run(request, body).pipe(
        Effect.map((result) => ({ ...result, matchedRuleIds: messageDecisionRules(kernel, id, request) })),
      );
      });
      return yield* captured.provide(work).pipe(Effect.provide(services));
    })));
  });
}
