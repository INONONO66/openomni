import { Effect, Semaphore } from "effect";
import { messageDecisionRules } from "./message-decision";
import { Kernel, Session, Bundle, Journal } from "@openomni/agent";
const adoptSessionAuthority = Session.adoptSessionAuthority;
const createExecutor = Kernel.createExecutor;
const BundleDefinitions = Bundle.BundleDefinitions;
type BundleDefinitions = Bundle.BundleDefinitions;
const Entropy = Kernel.Entropy;
const GenerationLayers = Kernel.GenerationLayers;
const CommitFailed = Kernel.CommitFailed;
const AgentFailure = Kernel.AgentFailure;
type ExecutionError = Kernel.ExecutionError;
type SessionEntryServices = Kernel.SessionEntryServices;
const CorruptRecord = Journal.CorruptRecord;
import type { LedgerAction, PlainValue } from "@openomni/protocol";
import type { createGatewayRouter } from "@openomni/channels";
import type { AppLedgerPlane } from "./cluster-runtime";
import { captureNow } from "./platform";

type ExecutionResult = Effect.Success<
  ReturnType<Effect.Success<ReturnType<typeof createExecutor>>["run"]>
>;
type Run = Parameters<typeof createGatewayRouter>[0]["run"];
type NativeRun = (
  sender: Parameters<Run>[0],
  request: Parameters<Run>[1],
  body: (intent: LedgerAction.Receipt) => Effect.Effect<PlainValue, ExecutionError>,
) => Effect.Effect<
  ExecutionResult & { readonly matchedRuleIds: readonly string[] },
  ExecutionError
>;

/** The fixed perimeter session every external decision is recorded against. */
export const GATEWAY_INGRESS_SESSION = "gateway-ingress";

/** External authentication has no active model turn; its message actions have one fenced owner. */
export function createIngressExecutor(
  plane: AppLedgerPlane,
): Effect.Effect<NativeRun, ExecutionError, SessionEntryServices | BundleDefinitions> {
  return Effect.gen(function* () {
    const id = GATEWAY_INGRESS_SESSION;
    const services = yield* Effect.context<SessionEntryServices>();
    const generations = yield* GenerationLayers;
    const clock = yield* captureNow;
    const { id: nextId } = yield* Entropy;
    const installed = yield* BundleDefinitions;
    const kernel = plane.openKernel(id);
    yield* kernel
      .materialize({
        id,
        parentId: null,
        role: "resident",
        tools: [],
        bundles: installed.names,
        system: { preset: "", blocks: [] },
        policyGeneration: kernel.currentPolicyGeneration(),
        actionId: nextId(),
        at: clock(),
      })
      .pipe(Effect.mapError((error) => new CommitFailed({ error })));
    plane.catalog.indexSession({ id, parentId: null, role: "resident", createdAt: clock() });
    const serial = yield* Semaphore.make(1);
    return (_sender, request, body) =>
      serial.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const row = kernel.row(id);
            const owner = nextId();
            const captured = yield* generations
              .capture({ sessionId: id, generation: row.toolsGeneration })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new AgentFailure({ operation: "ingress.capture", cause: String(error) }),
                ),
              );
            const fence = yield* adoptSessionAuthority(kernel, id, owner).pipe(
              Effect.mapError((error) => new CommitFailed({ error })),
            );
            const commit = (actions: readonly LedgerAction.Append[]) =>
              Effect.suspend(() =>
                kernel.commit({
                  sessionId: id,
                  owner,
                  fence,
                  now: clock(),
                  expectedRevision: kernel.row(id).revision,
                  actions: [...actions],
                  state: "idle",
                }),
              );
            const work = Effect.gen(function* () {
              const executor = yield* createExecutor({
                identity: { sessionId: id, role: "resident", parentActionId: null },
                ledger: {
                  commit: (action) =>
                    commit([action]).pipe(
                      Effect.flatMap((result) => {
                        const receipt = result.receipts[0];
                        return receipt === undefined
                          ? Effect.fail(
                              new CorruptRecord({ operation: "gateway.commit", id: action.id }),
                            )
                          : Effect.succeed(receipt);
                      }),
                    ),
                },
              });
              return yield* executor.run(request, body).pipe(
                Effect.map((result) => ({
                  ...result,
                  matchedRuleIds: messageDecisionRules(kernel, id, request),
                })),
              );
            });
            return yield* captured.provide(work).pipe(Effect.provide(services));
          }),
        ),
      );
  });
}
