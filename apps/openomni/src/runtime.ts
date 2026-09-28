import {
  AgentProcessLive,
  Bus,
  type BundleDefinitions,
  BundlesLive,
  type Clock,
  type Entropy,
  type GenerationLayers,
  type ObservationSink,
  type SessionEntityPorts,
  type SessionError,
} from "@openomni/agent";
import { LedgerStorageLive, type LedgerWrites, type LedgerError } from "@openomni/ledger";
import { LlmLive, type Llm } from "@openomni/llm";
import { Context, Data, Effect, Layer, type ManagedRuntime, type Scope, flow } from "effect";
import {
  clusterHostLayer,
  sessionEntityLayer,
  type ClusterServices,
} from "./composition/cluster-runtime";
import { GenerationLayersLive } from "./composition/generation-layers";

export class AppLifecycleFailure extends Data.TaggedError("AppLifecycleFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {}

export const lifecycleFailure = (operation: string) =>
  flow(String, (cause) => new AppLifecycleFailure({ operation, cause }));

export class AppScope extends Context.Service<AppScope, Scope.Scope>()(
  "@openomni/openomni/AppScope",
) {}

/** Cluster plane wiring (W5.2 #1197): catalog-backed host, per-session entity files. */
export interface AppClusterOptions {
  readonly catalogPath: string;
  readonly sessionsDir: string;
  readonly entityIdleMs: number;
  /** Session entity activation; present once composition supplies the turn port. */
  readonly entity?: {
    readonly owner: string;
    readonly ports: SessionEntityPorts;
  };
}

export interface AppRuntimeOptions {
  readonly dbPath: string;
  /**
   * Cluster storage. Absent (injected test runtimes) the host runs on an
   * in-memory catalog so composition stays uniform and hermetic.
   */
  readonly cluster?: AppClusterOptions;
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations?: typeof Bus;
  readonly llm?: Layer.Layer<Llm>;
  readonly bundles?: Layer.Layer<BundleDefinitions>;
}

function clusterLayers(options: AppRuntimeOptions) {
  const cluster = options.cluster;
  const host = clusterHostLayer({
    catalogPath: cluster?.catalogPath ?? ":memory:",
    entityIdleMs: cluster?.entityIdleMs ?? 60_000,
  }).pipe(Layer.orDie);
  const entity: Layer.Layer<never, never, ClusterServices> =
    cluster?.entity === undefined
      ? Layer.empty
      : sessionEntityLayer({
          catalogPath: cluster.catalogPath,
          sessionsDir: cluster.sessionsDir,
          owner: cluster.entity.owner,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ports: cluster.entity.ports,
        });
  return { host, entity };
}

export function AppLive(options: AppRuntimeOptions, bundles = options.bundles ?? BundlesLive([])) {
  const observations = options.observations ?? Bus;
  const ledger = LedgerStorageLive({ dbPath: options.dbPath, observationSink: observations });
  const process = AgentProcessLive(observations, {
    clock: options.clock,
    entropy: options.entropy,
  });
  const generations = GenerationLayersLive.pipe(
    Layer.provideMerge(Layer.mergeAll(process, bundles, ledger)),
  );
  const { host, entity } = clusterLayers(options);
  return Layer.mergeAll(
    Layer.effect(AppScope, Effect.scope).pipe(Layer.provideMerge(generations)),
    options.llm ?? LlmLive,
    entity,
  ).pipe(Layer.provideMerge(host));
}

export type AppServices =
  | Clock
  | Entropy
  | ObservationSink
  | LedgerWrites
  | AppScope
  | Llm
  | BundleDefinitions
  | GenerationLayers
  | ClusterServices;
type AppRuntimeError = AppLifecycleFailure | LedgerError | SessionError;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, AppRuntimeError>;
