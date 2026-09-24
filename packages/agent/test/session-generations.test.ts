import { expect, test } from "bun:test";
import { SessionHandleStore } from "@openomni/ledger";
import { KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import { Effect, Layer } from "effect";
import { NamedPolicyRegistry } from "../src/bundle";
import { AgentGenerationLive } from "../src/layers";
import { createObservationBus } from "../src/observation/bus";
import { ObservationSink } from "../src/services";
import { GenerationRawSlots, makeSessionGenerations, type GenerationBundle } from "../src/session-generations";
import { allowAllPolicy } from "./helpers/compiled-policy";
import { isolated } from "./helpers/isolated";

function bundle(generation: number, closed: number[]): GenerationBundle {
  const snapshot = SessionHandleStore.generationSnapshot({
    generation, revertTo: generation - 1, tools: [],
    system: { preset: "", blocks: [] }, policyGeneration: allowAllPolicy.generation,
  });
  return {
    id: { sessionId: "generation-drain", generation }, snapshot, activate: Effect.void,
    layer: Layer.mergeAll(
      AgentGenerationLive({ snapshot, policy: allowAllPolicy, definitions: [] }),
      Layer.succeed(ObservationSink, createObservationBus()),
      Layer.succeed(NamedPolicyRegistry, KERNEL_POLICY_REGISTRY),
      Layer.scopedDiscard(Effect.addFinalizer(() => Effect.sync(() => { closed.push(generation); }))),
    ),
  };
}

test("drain refuses retained owners and retires every settled generation", () =>
  isolated(Effect.gen(function* () {
    const closed: number[] = [];
    const manager = yield* makeSessionGenerations(bundle(1, closed));
    expect(yield* manager.configure(bundle(2, closed), Effect.succeed("committed"))).toBe("committed");
    expect(closed).toEqual([1]);
    const retained = yield* Effect.scoped(Effect.gen(function* () {
      const captured = yield* manager.capture();
      const owners = yield* captured.provide(GenerationRawSlots);
      return { release: captured.retain(), pending: owners.pending };
    }));
    try {
      expect(retained.pending()).toBe(1);
      expect(yield* Effect.either(manager.drain)).toMatchObject({
        _tag: "Left",
        left: { _tag: "GenerationUnsettled", sessionId: "generation-drain", generation: 2, owners: 1 },
      });
      expect(closed).toEqual([1]);
    } finally {
      retained.release();
    }
    expect(retained.pending()).toBe(0);
    yield* manager.drain;
    expect(closed).toEqual([1, 2]);
    yield* manager.drain;
    expect(closed).toEqual([1, 2]);
    expect(yield* Effect.either(manager.capture())).toMatchObject({
      _tag: "Left", left: { _tag: "GenerationUnavailable", generation: 2 },
    });
  })),
);
