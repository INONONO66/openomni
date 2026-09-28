import { AgentProcessLive, Bus, BundlesLive, GenerationLayers, type ObservationSink, type SessionRuntime } from "@openomni/agent";
import { Llm, LlmLive } from "@openomni/llm";
import type { AnyToolDefinition, LedgerSession } from "@openomni/protocol";
import { Effect, Layer, Scope, type Context } from "effect";
import { AppLedger, createAppLedger, type AppLedgerPlane } from "../../src/composition/cluster-runtime";
import { GenerationLayersLive } from "../../src/composition/generation-layers";

/** Tests grant configure EXPLICITLY; the app composition wires the real pinned pre-policy. */
export const allowConfigure: SessionRuntime["authorizeConfigure"] = () => Effect.succeed(true);

/** A borrowed-storage composition for package-boundary app fixtures. */
export function generationServices(options: {
  readonly definitions?: Readonly<Record<LedgerSession.Role, readonly AnyToolDefinition[]>>;
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations?: Context.Service.Shape<typeof ObservationSink>;
  readonly llm?: Context.Service.Shape<typeof Llm>;
  /** The app ledger plane the generation manager reads; absent builds a scoped in-memory one. */
  readonly plane?: AppLedgerPlane;
} = {}) {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const plane = options.plane === undefined
      ? yield* Effect.acquireRelease(
          Effect.sync(() => createAppLedger({ observationSink: options.observations ?? Bus })),
          (owned) => Effect.sync(() => owned.close()),
        ).pipe(Scope.provide(scope))
      : options.plane;
    const process = Layer.mergeAll(AgentProcessLive(options.observations ?? Bus, { clock: options.clock, entropy: options.entropy }), BundlesLive([]), Layer.succeed(AppLedger, plane));
    const layer = GenerationLayersLive.pipe(Layer.provideMerge(process), Layer.merge(options.llm === undefined ? LlmLive : Layer.succeed(Llm, options.llm)));
    const context = yield* Layer.buildWithScope(layer, scope);
    yield* Effect.flatMap(GenerationLayers, (generations) => generations.initialize(options.definitions ?? { resident: [], worker: [] })).pipe(Effect.provide(context));
    return context;
  });
}
