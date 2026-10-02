import { AppInvariantError } from "./invariant";
import { Kernel, Session, Bundle, type Journal, Model } from "@openomni/agent";
type BundleDefinitions = Bundle.BundleDefinitions;
const BundlesLive = Bundle.BundlesLive;
type Entropy = Kernel.Entropy;
type EntropySource = Kernel.EntropySource;
const ObservationSink = Kernel.ObservationSink;
type ObservationSink = Kernel.ObservationSink;
type SessionEntityPorts = Session.SessionEntityPorts;
type SessionError = Kernel.SessionError;
type GenerationLayers = Kernel.GenerationLayers;
import { AgentProcessLive } from "./agent-layers";
type LedgerError = Journal.LedgerError;
const LlmLive = Model.LlmLive;
type Llm = Model.Llm;
import { pid } from "node:process";
import { Context, Data, Effect, Layer, type ManagedRuntime, type Scope, flow } from "effect";
import {
  type AppLedger,
  appLedgerLayer,
  clusterHostLayer,
  createSessionEntityPortsSlot,
  sessionEntityLayer,
  type ClusterServices,
} from "./composition/cluster-runtime";
import { GenerationLayersLive } from "./composition/generation-layers";
import { AppPointTable, composedPointTable } from "./composition/point-table";
import { captureNow, platformEntropy, wallClockLayer } from "./composition/platform";

export class AppLifecycleFailure extends Data.TaggedError("AppLifecycleFailure")<{
  readonly operation: string;
  readonly cause: string;
}> {
  override get message(): string { return `${this.operation}: ${this.cause}`; }
}

export const lifecycleFailure = (operation: string) =>
  flow(String, (cause) => new AppLifecycleFailure({ operation, cause }));

export class AppScope extends Context.Service<AppScope, Scope.Scope>()(
  "@openomni/openomni/AppScope",
) {}

/**
 * The runtime-owned late-binding seam for the session entity's ports: the
 * entity layer always mounts (a runtime without it silently swallows every
 * delivery), and the composition root binds the real turn/timer ports here
 * once boot resolves them. Construction-time `entity` options pin the ports
 * instead; binding then is a wiring defect and dies loud.
 */
export class SessionEntityBinding extends Context.Service<
  SessionEntityBinding,
  { bind(ports: SessionEntityPorts): void }
>()("@openomni/openomni/SessionEntityBinding") {}

export interface AppRuntimeOptions {
  /** Catalog SQLite file (session index + cluster mailbox); absent = in-memory. */
  readonly catalogPath?: string;
  /** Directory of per-session ledger files; absent = in-memory session stores. */
  readonly sessionsDir?: string;
  /** Milliseconds of mailbox silence before a session entity passivates. */
  readonly entityIdleMs?: number;
  /**
   * Where the SingleRunner keeps its cluster_* tables; defaults to the
   * catalog. A process child MUST pin ":memory:" — two runners on one
   * catalog file would fight over the same runner tables.
   */
  readonly clusterStoragePath?: string;
  /** Session entity activation; present once composition supplies the turn port. */
  readonly entity?: {
    readonly owner: string;
    readonly ports: SessionEntityPorts;
  };
  /** Injected wall clock (#1245); absent = the bootstrap-captured Effect Clock. */
  readonly now?: () => number;
  /** Injected entropy source (#1245); absent = the platform CSPRNG. */
  readonly entropy?: EntropySource;
  readonly observations?: Context.Service.Shape<typeof ObservationSink>;
  readonly llm?: Layer.Layer<Llm>;
  readonly bundles?: Layer.Layer<BundleDefinitions>;
  /** The capability registrations this composition selects (#1251); absent = every built-in this app ships. */
  readonly capabilities?: readonly Kernel.CapabilityPointRegistration[];
}

export function AppLive(options: AppRuntimeOptions, bundles = options.bundles ?? BundlesLive([])) {
  const now = options.now === undefined ? captureNow : Effect.succeed(options.now);
  return Layer.unwrap(Effect.map(now, (captured) => appLayer(options, bundles, captured)));
}

function appLayer(options: AppRuntimeOptions, bundles: Layer.Layer<BundleDefinitions>, now: () => number) {
  const entropy = options.entropy ?? platformEntropy();
  // The root observation bus is app-owned (#1249): a Layer whose Scope is the
  // runtime's lifetime. Injected fixture sinks mount as plain values.
  const sinkLayer: Layer.Layer<ObservationSink> =
    options.observations === undefined
      ? Session.observationBusLayer({ id: entropy.id, now })
      : Layer.succeed(ObservationSink, options.observations);
  return Layer.unwrap(Effect.gen(function* () {
    const observations = yield* ObservationSink;
    return wiredLayer(options, bundles, now, entropy, observations);
  })).pipe(Layer.provideMerge(sinkLayer));
}

function wiredLayer(
  options: AppRuntimeOptions,
  bundles: Layer.Layer<BundleDefinitions>,
  now: () => number,
  entropy: EntropySource,
  observations: Context.Service.Shape<typeof ObservationSink>,
) {
  const plane = appLedgerLayer({
    now,
    ...(options.catalogPath === undefined ? {} : { catalogPath: options.catalogPath }),
    ...(options.sessionsDir === undefined ? {} : { sessionsDir: options.sessionsDir }),
    observationSink: observations,
  });
  const process = AgentProcessLive(observations, entropy);
  const pointTable = Layer.succeed(AppPointTable, composedPointTable(options.capabilities));
  const generations = GenerationLayersLive.pipe(
    Layer.provideMerge(Layer.mergeAll(process, bundles, plane, pointTable)),
  );
  const host = clusterHostLayer({
    catalogPath: options.clusterStoragePath ?? options.catalogPath ?? ":memory:",
    entityIdleMs: options.entityIdleMs ?? 60_000,
  }).pipe(Layer.orDie);
  const seam =
    options.entity === undefined
      ? (() => {
          const slot = createSessionEntityPortsSlot();
          return { owner: `openomni:${pid}`, ports: slot.ports, bind: slot.bind };
        })()
      : {
          owner: options.entity.owner,
          ports: options.entity.ports,
          bind: (): void => {
            throw new AppInvariantError("session entity ports were fixed at runtime construction");
          },
        };
  const entity: Layer.Layer<never, never, ClusterServices | AppLedger> = sessionEntityLayer({
    owner: seam.owner,
    clock: now,
    ports: seam.ports,
  });
  const binding = Layer.succeed(SessionEntityBinding, { bind: seam.bind });
  const app = Layer.mergeAll(
    Layer.effect(AppScope, Effect.scope).pipe(Layer.provideMerge(generations)),
    options.llm ?? LlmLive,
    binding,
    pointTable,
    entity.pipe(Layer.provide(plane)),
  ).pipe(Layer.provideMerge(host));
  return options.now === undefined ? app : Layer.mergeAll(app, wallClockLayer(now));
}

export type AppServices =
  | Entropy
  | ObservationSink
  | AppLedger
  | AppPointTable
  | AppScope
  | Llm
  | BundleDefinitions
  | GenerationLayers
  | SessionEntityBinding
  | ClusterServices;
type AppRuntimeError = AppLifecycleFailure | LedgerError | SessionError;
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, AppRuntimeError>;
