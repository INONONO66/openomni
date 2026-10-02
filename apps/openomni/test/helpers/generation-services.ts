import { Kernel, type Session, Bundle, Model } from "@openomni/agent";
const BundlesLive = Bundle.BundlesLive;
const GenerationLayers = Kernel.GenerationLayers;
const ObservationSink = Kernel.ObservationSink;
type SessionRuntime = Session.SessionRuntime;
import { AgentProcessLive } from "../../src/agent-layers";
import { Bus } from "./bus";
const Llm = Model.Llm;
const LlmLive = Model.LlmLive;
import type { AnyToolDefinition, LedgerSession } from "@openomni/protocol";
import { Effect, Layer, Scope, type Context } from "effect";
import { AppLedger, createAppLedger, type AppLedgerPlane } from "../../src/composition/cluster-runtime";
import { GenerationLayersLive } from "../../src/composition/generation-layers";
import { wallClockLayer } from "../../src/composition/platform";
import { testClock, testEntropy } from "./test-entropy";

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
    const now = options.clock ?? testClock();
    const plane = options.plane === undefined
      ? yield* Effect.acquireRelease(
          Effect.sync(() => createAppLedger({ now, observationSink: options.observations ?? Bus })),
          (owned) => Effect.sync(() => owned.close()),
        ).pipe(Scope.provide(scope))
      : options.plane;
    const process = Layer.mergeAll(
      AgentProcessLive(options.observations ?? Bus, testEntropy(options.entropy)),
      BundlesLive([]),
      Layer.succeed(AppLedger, plane),
      wallClockLayer(now),
    );
    const layer = GenerationLayersLive.pipe(Layer.provideMerge(process), Layer.merge(options.llm === undefined ? LlmLive : Layer.succeed(Llm, options.llm)));
    const context = yield* Layer.buildWithScope(layer, scope);
    yield* Effect.flatMap(GenerationLayers, (generations) => generations.initialize(options.definitions ?? { resident: [], worker: [] })).pipe(Effect.provide(context));
    return context;
  });
}
