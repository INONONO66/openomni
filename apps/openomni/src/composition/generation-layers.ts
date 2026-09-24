import {
  AgentGenerationLive, BundleDefinitions, BundleError, type Clock, type Entropy, ForeignFailure,
  GenerationLayers, GenerationUnavailable, NamedPolicyRegistry, ObservationSink,
  ToolCatalog, createObservationBus, makeSessionGenerations, scopeObservation,
  type GenerationBundle, type SessionError,
} from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { compilePolicySnapshot } from "@openomni/policy";
import { LedgerAction, type AnyToolDefinition, type LedgerSession, type SessionGeneration } from "@openomni/protocol";
import { Context, Effect, Layer, Scope } from "effect";

type Definitions = Readonly<Record<LedgerSession.Role, readonly AnyToolDefinition[]>>;

/** The app owns construction; the package manager alone owns acquired contexts. */
export const GenerationLayersLive = Layer.scoped(GenerationLayers, Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const installed = yield* BundleDefinitions;
  const process = yield* Effect.context<Clock | Entropy | ObservationSink>();
  const root = Context.get(process, ObservationSink);
  const lock = yield* Effect.makeSemaphore(1);
  const managers = new Map<string, Effect.Effect.Success<ReturnType<typeof makeSessionGenerations>>>();
  let definitions: Definitions | undefined;
  let stopping = false;

  function bundle(sessionId: string, snapshot: SessionGeneration.Snapshot): Effect.Effect<GenerationBundle, SessionError> {
    return Effect.gen(function* () {
      if (definitions === undefined) return yield* new ForeignFailure({ operation: "generation.initialize", cause: "not_initialized" });
      const selected = yield* Effect.try({
        try: () => installed.select(snapshot.bundles),
        catch: (error) => error instanceof BundleError ? error : new ForeignFailure({ operation: "generation.select", cause: String(error) }),
      });
      const role = SessionHandleStore.row(sessionId).role;
      const offered = new Set(snapshot.tools.map((tool) => tool.name));
      const catalog = [...definitions[role], ...selected.tools].filter((tool) => offered.has(tool.name));
      let active = false;
      const observations = Layer.scoped(ObservationSink, Effect.acquireRelease(
        Effect.sync(() => {
          const bus = createObservationBus();
          const sink: Context.Tag.Service<typeof ObservationSink> = {
            publish: (event, data) => { if (active) { bus.publish(event, data); root.publish(event, data); } },
            subscribe: bus.subscribe,
            scope: (identity) => scopeObservation(sink, identity),
          };
          return { ...sink, close: () => { active = false; bus.reset(); } };
        }),
        (sink) => Effect.sync(sink.close),
      ));
      const seed = Layer.mergeAll(Layer.succeedContext(process), Layer.succeed(ToolCatalog, { definitions: catalog }), observations);
      const registry = selected.layer.pipe(Layer.provideMerge(seed));
      const layer = Layer.unwrapEffect(Effect.gen(function* () {
        const registry = yield* NamedPolicyRegistry;
        const policy = yield* Effect.try({
          try: () => compilePolicySnapshot({ rows: SessionHandleStore.policyRows(snapshot.policyGeneration), generation: snapshot.policyGeneration, kinds: LedgerAction.Kind.options, registry }),
          catch: (error) => new ForeignFailure({ operation: "generation.policy", cause: String(error) }),
        });
        return AgentGenerationLive({ snapshot, policy, definitions: catalog });
      })).pipe(Layer.provideMerge(registry));
      return { id: { sessionId, generation: snapshot.generation }, snapshot, layer, activate: Effect.sync(() => { active = true; }) };
    });
  }

  function manager(sessionId: string) {
    return lock.withPermits(1)(Effect.gen(function* () {
      if (stopping) return yield* new ForeignFailure({ operation: "generation.capture", cause: "draining" });
      let owner = managers.get(sessionId);
      if (owner === undefined) {
        const initial = yield* bundle(sessionId, SessionHandleStore.latestGenerationFor(sessionId));
        owner = yield* makeSessionGenerations(initial).pipe(Scope.extend(scope));
        managers.set(sessionId, owner);
      }
      return owner;
    }));
  }

  return {
    initialize: (input: Definitions) => Effect.suspend(() => {
      if (definitions !== undefined) return Effect.fail(new ForeignFailure({ operation: "generation.initialize", cause: "already_initialized" }));
      definitions = Object.freeze({ resident: Object.freeze([...input.resident]), worker: Object.freeze([...input.worker]) });
      return Effect.void;
    }),
    capture: (id: SessionGeneration.Id) => Effect.gen(function* () {
      const owner = yield* manager(id.sessionId);
      const snapshot = SessionHandleStore.generationFor(id.sessionId, id.generation);
      if (snapshot === undefined) return yield* new GenerationUnavailable({ generation: id.generation });
      return yield* owner.capture(yield* bundle(id.sessionId, snapshot));
    }),
    configure: <A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>) => Effect.gen(function* () {
      if (id.generation !== snapshot.generation) return yield* new ForeignFailure({ operation: "generation.configure", cause: "snapshot_identity_mismatch" });
      const owner = yield* manager(id.sessionId);
      return yield* owner.configure(yield* bundle(id.sessionId, snapshot), commit);
    }),
    drain: lock.withPermits(1)(Effect.gen(function* () {
      stopping = true;
      yield* Effect.forEach(managers.values(), (owner) => owner.drain, { discard: true });
    })),
  };
}));
