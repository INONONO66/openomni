import { AgentProcessLive, Bus, type BundleDefinitions, BundlesLive, type Clock, type Entropy, type GenerationLayers, type ObservationSink, type SessionError } from "@openomni/agent";
import { LedgerStorageLive, type LedgerWrites, type LedgerError } from "@openomni/ledger";
import { LlmLive, type Llm } from "@openomni/llm";
import { Context, Data, Effect, Layer, type ManagedRuntime, type Scope, flow } from "effect";
import { GenerationLayersLive } from "./composition/generation-layers";

export class AppLifecycleFailure extends Data.TaggedError("AppLifecycleFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {}

export const lifecycleFailure = (operation: string) =>
  flow(String, (cause) => new AppLifecycleFailure({ operation, cause }));

export class AppScope extends Context.Tag("@openomni/openomni/AppScope")<AppScope, Scope.Scope>() {}

export interface AppRuntimeOptions {
  readonly dbPath: string;
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations?: typeof Bus;
  readonly llm?: Layer.Layer<Llm>;
  readonly bundles?: Layer.Layer<BundleDefinitions>;
}

export function AppLive(options: AppRuntimeOptions, bundles = options.bundles ?? BundlesLive([])) {
  const observations = options.observations ?? Bus;
  const ledger = LedgerStorageLive({ dbPath: options.dbPath, observationSink: observations });
  const process = AgentProcessLive(observations, { clock: options.clock, entropy: options.entropy });
  const generations = GenerationLayersLive.pipe(Layer.provideMerge(Layer.mergeAll(process, bundles, ledger)));
  return Layer.mergeAll(
    Layer.scoped(AppScope, Effect.scope).pipe(Layer.provideMerge(generations)),
    options.llm ?? LlmLive,
  );
}

export type AppServices = Clock | Entropy | ObservationSink | LedgerWrites | AppScope | Llm | BundleDefinitions | GenerationLayers;
type AppRuntimeError = AppLifecycleFailure | LedgerError | SessionError;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, AppRuntimeError>;
