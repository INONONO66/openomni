import { SessionHandleStore } from "@openomni/ledger";
import type { AnyToolDefinition } from "@openomni/protocol";
import { Context, Effect, Layer } from "effect";
import { LlmLive } from "@openomni/llm";
import { KERNEL_POLICY_REGISTRY, SEEDED_POLICY_ROWS, compilePolicySnapshot } from "@openomni/policy";
import type { ResolvedExecutorOptions } from "../../src/executor-contract";
import { Clock, Entropy, GenerationOwnership, ObservationSink, SessionLayer, ToolCatalog, type GenerationServices } from "../../src/services";
import { NamedPolicyRegistry } from "../../src/bundle";
import { makeSessionGenerations, type GenerationRawSlots } from "../../src/session-generations";
import { createObservationBus, scopeObservation } from "../../src/observation/bus";
import type { createTurnDispatcher } from "../../src/tool-dispatcher";

export function turnTestLayer(input: Parameters<typeof createTurnDispatcher>[0] & { readonly policy?: ResolvedExecutorOptions["policy"] },
  fixture: Parameters<typeof createTurnDispatcher>[1] & Partial<Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations">>) {
  return Layer.effectContext(Effect.gen(function* () {
    const current = yield* SessionLayer;
    const clock = yield* Clock;
    const entropy = yield* Entropy;
    const observations = yield* ObservationSink;
    return Context.make(SessionLayer, { ...current, policy: input.policy ?? current.policy }).pipe(
      Context.add(Clock, { now: fixture.clock ?? clock.now }), Context.add(Entropy, { next: fixture.entropy ?? entropy.next }),
      Context.add(ObservationSink, fixture.observations === undefined ? observations : observationService(fixture.observations)),
    );
  }));
}

export function observationService(sink: ResolvedExecutorOptions["observations"]) {
  const bus = createObservationBus();
  const service = {
    publish: ((event, data) => { sink.publish(event, data); bus.publish(event, data); }) satisfies typeof bus.publish,
    subscribe: "subscribe" in sink && sink.subscribe !== undefined ? sink.subscribe.bind(sink) : bus.subscribe,
    scope: (identity: Parameters<typeof scopeObservation>[1]): import("@openomni/protocol").ObservationSink => scopeObservation(service, identity),
  };
  return service;
}

/** Fixture values become actual providers, not executor option overrides. */
export function executorLayer(values: Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations" | "policy">) {
  const snapshot = SessionHandleStore.generationSnapshot({ generation: 1, revertTo: 0, tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: values.policy.generation });
  return Layer.mergeAll(
    Layer.succeed(Clock, { now: values.clock }), Layer.succeed(Entropy, { next: values.entropy }),
    Layer.succeed(ObservationSink, observationService(values.observations)),
    Layer.succeed(SessionLayer, { snapshot, policy: values.policy }),
  );
}

export function catalogLayer(definitions: readonly AnyToolDefinition[]) {
  return Layer.succeed(ToolCatalog, { definitions });
}

export const runnerTestLayer = Layer.mergeAll(
  LlmLive, Layer.succeed(Clock, { now: Date.now }), Layer.succeed(Entropy, { next: () => crypto.randomUUID() }),
  Layer.scopedContext(Effect.gen(function* () {
    const snapshot = SessionHandleStore.generationSnapshot({ generation: 1, revertTo: 0, tools: [], system: { preset: "", blocks: [] }, policyGeneration: 1 });
    const policy = compilePolicySnapshot({ registry: KERNEL_POLICY_REGISTRY, generation: 1, rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })) });
    const owner = yield* makeSessionGenerations({ id: { sessionId: "fixture", generation: 1 }, snapshot, activate: Effect.void,
      layer: Layer.mergeAll(Layer.succeed(SessionLayer, { snapshot, policy }), Layer.succeed(ToolCatalog, { definitions: [] }),
        Layer.succeed(ObservationSink, createObservationBus()), Layer.succeed(NamedPolicyRegistry, KERNEL_POLICY_REGISTRY)) });
    const captured = yield* owner.capture();
    const context = yield* captured.provide(Effect.context<GenerationServices | GenerationOwnership | GenerationRawSlots>());
    return Context.pick(SessionLayer, ToolCatalog, ObservationSink, NamedPolicyRegistry, GenerationOwnership)(context);
  })),
);
