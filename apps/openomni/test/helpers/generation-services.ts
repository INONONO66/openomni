import { AgentProcessLive, Bus, BundlesLive, Clock, Entropy, GenerationLayers, type ObservationSink } from "@openomni/agent";
import { Llm, LlmLive } from "@openomni/llm";
import type { AnyToolDefinition, LedgerSession } from "@openomni/protocol";
import { Effect, Layer, Scope, type Context } from "effect";
import { GenerationLayersLive } from "../../src/composition/generation-layers";

/** A borrowed-storage composition for package-boundary app fixtures. */
export function generationServices(options: {
  readonly definitions?: Readonly<Record<LedgerSession.Role, readonly AnyToolDefinition[]>>;
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations?: Context.Tag.Service<typeof ObservationSink>;
  readonly llm?: Context.Tag.Service<typeof Llm>;
} = {}) {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const process = Layer.mergeAll(AgentProcessLive(options.observations ?? Bus), BundlesLive([])).pipe(
      Layer.merge(Layer.succeed(Clock, { now: options.clock ?? Date.now })),
      Layer.merge(Layer.succeed(Entropy, { next: options.entropy ?? (() => crypto.randomUUID()) })),
    );
    const layer = GenerationLayersLive.pipe(Layer.provideMerge(process), Layer.merge(options.llm === undefined ? LlmLive : Layer.succeed(Llm, options.llm)));
    const context = yield* Layer.buildWithScope(layer, scope);
    yield* Effect.flatMap(GenerationLayers, (generations) => generations.initialize(options.definitions ?? { resident: [], worker: [] })).pipe(Effect.provide(context));
    return context;
  });
}
