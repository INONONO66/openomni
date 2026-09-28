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
import { LedgerWrites, type LedgerError } from "@openomni/ledger";
import { LlmLive, type Llm } from "@openomni/llm";
import { Context, Data, Effect, Layer, type ManagedRuntime, type Scope, flow } from "effect";
import {
  AppLedger,
  appLedgerLayer,
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

export interface AppRuntimeOptions {
  /** Catalog SQLite file (session index + cluster mailbox); absent = in-memory. */
  readonly catalogPath?: string;
  /** Directory of per-session ledger files; absent = in-memory session stores. */
  readonly sessionsDir?: string;
  /** Milliseconds of mailbox silence before a session entity passivates. */
  readonly entityIdleMs?: number;
  /** Session entity activation; present once composition supplies the turn port. */
  readonly entity?: {
    readonly owner: string;
    readonly ports: SessionEntityPorts;
  };
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations?: typeof Bus;
  readonly llm?: Layer.Layer<Llm>;
  readonly bundles?: Layer.Layer<BundleDefinitions>;
}

export function AppLive(options: AppRuntimeOptions, bundles = options.bundles ?? BundlesLive([])) {
  const observations = options.observations ?? Bus;
  const plane = appLedgerLayer({
    ...(options.catalogPath === undefined ? {} : { catalogPath: options.catalogPath }),
    ...(options.sessionsDir === undefined ? {} : { sessionsDir: options.sessionsDir }),
    observationSink: observations,
  });
  // The ledger service plane is THE plane: LedgerWrites is a projection of the
  // same handles, so composition and entity activations share one catalog.
  const ledger = Layer.effect(
    LedgerWrites,
    Effect.map(AppLedger, (appLedger) => appLedger.handles),
  ).pipe(Layer.provideMerge(plane));
  const process = AgentProcessLive(observations, {
    clock: options.clock,
    entropy: options.entropy,
  });
  const generations = GenerationLayersLive.pipe(
    Layer.provideMerge(Layer.mergeAll(process, bundles, ledger)),
  );
  const host = clusterHostLayer({
    catalogPath: options.catalogPath ?? ":memory:",
    entityIdleMs: options.entityIdleMs ?? 60_000,
  }).pipe(Layer.orDie);
  const entity: Layer.Layer<never, never, ClusterServices | AppLedger> =
    options.entity === undefined
      ? Layer.empty
      : sessionEntityLayer({
          owner: options.entity.owner,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ports: options.entity.ports,
        });
  return Layer.mergeAll(
    Layer.effect(AppScope, Effect.scope).pipe(Layer.provideMerge(generations)),
    options.llm ?? LlmLive,
    entity.pipe(Layer.provide(plane)),
  ).pipe(Layer.provideMerge(host));
}

export type AppServices =
  | Clock
  | Entropy
  | ObservationSink
  | LedgerWrites
  | AppLedger
  | AppScope
  | Llm
  | BundleDefinitions
  | GenerationLayers
  | ClusterServices;
type AppRuntimeError = AppLifecycleFailure | LedgerError | SessionError;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, AppRuntimeError>;
