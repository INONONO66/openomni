import {
  BundleDefinitions, BundleError, type Clock, type Entropy, ForeignFailure,
  GenerationLayers, GenerationUnavailable, NamedPolicyRegistry, ObservationSink, SessionLayer,
  ToolCatalog, createObservationBus, makeSessionGenerations, scopeObservation,
  type GenerationBundle, type SessionError, type SessionRuntime,
} from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { compilePolicySnapshot } from "@openomni/policy";
import { LedgerAction, type AnyToolDefinition, type SessionGeneration } from "@openomni/protocol";
import { Context, Effect, Layer, Scope } from "effect";

import type { GenerationDefinitions } from "../tools/core/catalog";

/** The app owns construction; the package manager alone owns acquired contexts. */
export const GenerationLayersLive = Layer.scoped(GenerationLayers, Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const installed = yield* BundleDefinitions;
  const process = yield* Effect.context<Clock | Entropy | ObservationSink>();
  const root = Context.get(process, ObservationSink);
  const lock = yield* Effect.makeSemaphore(1);
  const managers = new Map<string, Effect.Effect.Success<ReturnType<typeof makeSessionGenerations>>>();
  let definitions: GenerationDefinitions | undefined;
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
      const select = (tools: readonly AnyToolDefinition[]) => [...tools, ...selected.tools].filter(
        (tool) => offered.has(tool.name) && (tool.visibility.model.includes(role) || tool.visibility.cell.includes(role)),
      );
      const source = definitions;
      const catalog = Layer.suspend(() => source.catalogLayer === undefined
        ? Layer.sync(ToolCatalog, () => ({ definitions: Object.freeze(select(source[role])) }))
        : source.catalogLayer(select));
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
      const seed = Layer.mergeAll(Layer.succeedContext(process), catalog, observations);
      const registry = selected.layer.pipe(Layer.provideMerge(seed));
      const layer = Layer.unwrapEffect(Effect.gen(function* () {
        const registry = yield* NamedPolicyRegistry;
        const policy = yield* Effect.try({
          try: () => compilePolicySnapshot({ rows: SessionHandleStore.policyRows(snapshot.policyGeneration), generation: snapshot.policyGeneration, kinds: LedgerAction.Kind.options, registry }),
          catch: (error) => new ForeignFailure({ operation: "generation.policy", cause: String(error) }),
        });
        return Layer.succeed(SessionLayer, { snapshot, policy });
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
    initialize: (input: GenerationDefinitions) => Effect.suspend(() => {
      if (definitions !== undefined) return Effect.fail(new ForeignFailure({ operation: "generation.initialize", cause: "already_initialized" }));
      definitions = Object.freeze({ resident: Object.freeze([...input.resident]), worker: Object.freeze([...input.worker]), catalogLayer: input.catalogLayer });
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

/**
 * The app's `session.configure` authority: evaluate the session's captured
 * generation Layer's pinned pre-policy. Deny (or any non-allow verdict) fails
 * closed; there is no callback fallback.
 */
export function configureAuthority(
  generations: Context.Tag.Service<typeof GenerationLayers>,
): SessionRuntime["authorizeConfigure"] {
  return (input) => Effect.scoped(Effect.gen(function* () {
    const captured = yield* generations.capture({
      sessionId: input.sessionId,
      generation: SessionHandleStore.latestGenerationFor(input.sessionId).generation,
    });
    const { policy } = yield* captured.provide(SessionLayer);
    return policy.evaluate({
      kind: "session.configure", phase: "pre", op: input.operation,
      role: input.role, sessionId: input.sessionId,
      value: { op: input.operation, generation: input.generation },
    }).verdict === "allow";
  }));
}
