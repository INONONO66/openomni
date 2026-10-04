import { LlmLive } from "../../src/model";
import { createPolicyCompiler, KERNEL_POLICY_REGISTRY } from "../../src/core/gate/compile";
import { LedgerAction, type ObservationSink as ObservationPort, type SessionGeneration } from "@openomni/protocol";
import { Clock, type Context, Effect, Layer, Scope, Semaphore } from "effect";
import { GenerationHandlers } from "../../src/core/compose";
import type { SessionKernel } from "../../src/core/entity";
import { GenerationUnavailable, type SessionError } from "../../src/core/failure";
import { AgentGenerationLive } from "./generation-layer";
import { makeSessionGenerations, type GenerationBundle } from "../../src/core/run";
import type { SessionRuntime } from "../../src/core/run";
import { Entropy, GenerationLayers, ObservationSink, type SessionEntryServices } from "../../src/core/ports";
import { isolatedLedger } from "./isolated";
import { observationService } from "./service-layers";
import { entropySource, fixedClock } from "./time";
import { parentReply } from "./composition-fixtures";

/** Tests grant configure EXPLICITLY; production composition wires the real pinned pre-policy. */
export const allowConfigure: SessionRuntime["authorizeConfigure"] = () => Effect.succeed(true);

export interface SessionFixture extends SessionRuntime {
  readonly clock?: () => number;
  readonly entropy?: () => string;
  readonly observations: ObservationPort;
}

/** The kernel plane every fixture rides inside `isolated()`: the isolation's shared kernel, resolved lazily. */
export function isolatedRuntime(): Pick<SessionRuntime, "openKernel" | "listSessions" | "parentReply"> {
  return kernelRuntime(() => isolatedLedger().kernel);
}

/** A runtime kernel plane over one explicit kernel handle (crash children own their stores). */
export function kernelRuntime(kernel: () => SessionKernel): Pick<SessionRuntime, "openKernel" | "listSessions" | "parentReply"> {
  // #1276: parent replies are composition-injected; fixtures keep the shipped behavior.
  return { openKernel: () => kernel(), listSessions: () => kernel().listRows(), parentReply };
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
    const lock = yield* Semaphore.make(1);
    const managers = new Map<string, Effect.Success<ReturnType<typeof makeSessionGenerations>>>();
    const observations = observationService(fixture.observations);
    const compiler = createPolicyCompiler({ registry: KERNEL_POLICY_REGISTRY, kinds: LedgerAction.Kind.options,
      source: { rows: (generation?: number) => fixture.openKernel("policy").policyRows(generation) } });
    function bundle(sessionId: string, snapshot: SessionGeneration.Snapshot): GenerationBundle {
      return {
        id: { sessionId, generation: snapshot.generation }, snapshot, activate: Effect.void,
        layer: Layer.mergeAll(
          AgentGenerationLive({ snapshot, policy: compiler.pin(snapshot.policyGeneration), definitions: [] }),
          Layer.succeed(ObservationSink, observations), Layer.succeed(GenerationHandlers, KERNEL_POLICY_REGISTRY),
        ),
      };
    }
    function manager(sessionId: string) {
      return lock.withPermits(1)(Effect.gen(function* () {
        let value = managers.get(sessionId);
        if (value === undefined) {
          value = yield* makeSessionGenerations(bundle(sessionId, fixture.openKernel(sessionId).latestGenerationFor(sessionId))).pipe(Effect.provideService(Scope.Scope, scope));
          managers.set(sessionId, value);
        }
        return value;
      }));
    }
    const generations: Context.Service.Shape<typeof GenerationLayers> = {
      initialize: () => Effect.void,
      capture: (id: SessionGeneration.Id) => Effect.gen(function* () {
        const snapshot = fixture.openKernel(id.sessionId).generationFor(id.sessionId, id.generation);
        if (snapshot === undefined) return yield* new GenerationUnavailable({ generation: id.generation });
        const owner = yield* manager(id.sessionId);
        return yield* owner.capture(bundle(id.sessionId, snapshot));
      }),
      configure: <A>(id: SessionGeneration.Id, snapshot: SessionGeneration.Snapshot, commit: Effect.Effect<A, SessionError>) =>
        Effect.flatMap(manager(id.sessionId), (owner: Effect.Success<ReturnType<typeof makeSessionGenerations>>) => owner.configure(bundle(id.sessionId, snapshot), commit)),
      settle: Effect.suspend(() => Effect.forEach(managers.values(), (owner: Effect.Success<ReturnType<typeof makeSessionGenerations>>) => owner.settle, { discard: true })),
      drain: Effect.suspend(() => Effect.forEach(managers.values(), (owner: Effect.Success<ReturnType<typeof makeSessionGenerations>>) => owner.drain, { discard: true })),
    };
    const live = yield* Clock.clockWith(Effect.succeed);
    const context = yield* Layer.buildWithScope(Layer.mergeAll(
      LlmLive,
      Layer.succeed(Clock.Clock, fixture.clock === undefined ? live : fixedClock(fixture.clock)),
      Layer.succeed(Entropy, fixture.entropy === undefined ? entropySource("session") : { id: fixture.entropy, random: () => 0 }),
      Layer.succeed(ObservationSink, observations), Layer.succeed(GenerationLayers, generations),
    ), scope);
    cache.set(fixture, context);
    return context;
  });
}

export function withSessionServices<A, E, R>(work: Effect.Effect<A, E, R>, fixture: SessionFixture) {
  return Effect.flatMap(sessionServices(fixture), (context: Context.Context<SessionEntryServices>) => Effect.provide(work, context));
}
