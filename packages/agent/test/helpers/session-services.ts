import { sessionTree } from "../../../ledger/test/helpers/session-tree";
import { SessionHandleStore } from "@openomni/ledger";
import { LlmLive } from "@openomni/llm";
import { createPolicyCompiler, KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import { LedgerAction, type ObservationSink as ObservationPort, type SessionGeneration } from "@openomni/protocol";
import { type Context, Effect, Layer, Scope } from "effect";
import { NamedPolicyRegistry } from "../../src/bundle";
import { GenerationUnavailable, type SessionError } from "../../src/errors";
import { AgentGenerationLive } from "../../src/layers";
import { makeSessionGenerations, type GenerationBundle } from "../../src/session-generations";
import type { SessionRuntime } from "../../src/session-contract";
import { Clock, Entropy, GenerationLayers, ObservationSink, type SessionEntryServices } from "../../src/services";
import { observationService } from "./service-layers";

export interface SessionFixture extends SessionRuntime {
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations: ObservationPort;
}

const fixtures = new WeakMap<Scope.Scope, WeakMap<SessionFixture, Context.Context<SessionEntryServices>>>();

/** Test composition uses the real manager and durable snapshots, with no policy bypass. */
function sessionServices(fixture: SessionFixture) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let cache = fixtures.get(scope);
    if (cache === undefined) { cache = new WeakMap(); fixtures.set(scope, cache); }
    const cached = cache.get(fixture);
    if (cached !== undefined) return cached;
    const lock = yield* Effect.makeSemaphore(1);
    const managers = new Map<string, Effect.Effect.Success<ReturnType<typeof makeSessionGenerations>>>();
    const observations = observationService(fixture.observations);
    const compiler = createPolicyCompiler({ registry: KERNEL_POLICY_REGISTRY, kinds: LedgerAction.Kind.options,
      source: { append: () => false, rows: (generation) => SessionHandleStore.policyRows(generation) } });
    function bundle(sessionId: string, snapshot: SessionGeneration.Snapshot): GenerationBundle {
      return {
        id: { sessionId, generation: snapshot.generation }, snapshot, activate: Effect.void,
        layer: Layer.mergeAll(
          AgentGenerationLive({ snapshot, policy: compiler.pin(snapshot.policyGeneration), definitions: [] }),
          Layer.succeed(ObservationSink, observations), Layer.succeed(NamedPolicyRegistry, KERNEL_POLICY_REGISTRY),
        ),
      };
    }
    function manager(sessionId: string) {
      return lock.withPermits(1)(Effect.gen(function* () {
        let value = managers.get(sessionId);
        if (value === undefined) {
          value = yield* makeSessionGenerations(bundle(sessionId, SessionHandleStore.latestGenerationFor(sessionId))).pipe(Effect.provideService(Scope.Scope, scope));
          managers.set(sessionId, value);
        }
        return value;
      }));
    }
    const generations: Context.Tag.Service<typeof GenerationLayers> = {
      initialize: () => Effect.void,
      capture: (id) => Effect.gen(function* () {
        const snapshot = SessionHandleStore.generationByNumber(sessionTree(id.sessionId), id.generation);
        if (snapshot === undefined) return yield* new GenerationUnavailable({ generation: id.generation });
        const owner = yield* manager(id.sessionId);
        return yield* owner.capture(bundle(id.sessionId, snapshot));
      }),
      configure: <A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>) =>
        Effect.flatMap(manager(id.sessionId), (owner) => owner.configure(bundle(id.sessionId, snapshot), commit)),
      drain: Effect.suspend(() => Effect.forEach(managers.values(), (owner) => owner.drain, { discard: true })),
    };
    const context = yield* Layer.buildWithScope(Layer.mergeAll(
      LlmLive, Layer.succeed(Clock, { now: fixture.clock ?? Date.now }),
      Layer.succeed(Entropy, { next: fixture.entropy ?? (() => crypto.randomUUID()) }),
      Layer.succeed(ObservationSink, observations), Layer.succeed(GenerationLayers, generations),
    ), scope);
    cache.set(fixture, context);
    return context;
  });
}

export function withSessionServices<A, E, R>(work: Effect.Effect<A, E, R>, fixture: SessionFixture) {
  return Effect.flatMap(sessionServices(fixture), (context) => Effect.provide(work, context));
}
