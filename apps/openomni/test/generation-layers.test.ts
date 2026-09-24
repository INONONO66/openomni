import { expect, test } from "bun:test";
import { bundle, BundlesLive, ForeignFailure, GenerationLayers, ObservationSink, SessionLayer, session } from "@openomni/agent";
import { SessionHandleStore } from "@openomni/ledger";
import { Effect, Layer } from "effect";
import { z } from "zod";
import { seedKernelPolicyRows } from "../src/policy-seed";
import { acquireAppResource, gatewayRuntime, runAppEffect } from "../src/gateway";
import { allowConfigure } from "./helpers/generation-services";
import { configureAuthority } from "../src/composition/generation-layers";

test("AppLive retains distinct same-number session generations", async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:" });
  try {
    const values = await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const policyGeneration = seedKernelPolicyRows();
      yield* generations.initialize({ resident: [], worker: [] });
      for (const id of ["first", "second"]) yield* SessionHandleStore.materialize({
        id, parentId: null, role: "resident", tools: [], system: { preset: id, blocks: [] },
        policyGeneration, actionId: `${id}-create`, at: 1,
      });
      const first = yield* generations.capture({ sessionId: "first", generation: 1 });
      const again = yield* generations.capture({ sessionId: "first", generation: 1 });
      const second = yield* generations.capture({ sessionId: "second", generation: 1 });
      const a = yield* first.provide(SessionLayer);
      const b = yield* again.provide(SessionLayer);
      const c = yield* second.provide(SessionLayer);
      return { a, b, c };
    })));
    expect(values.a).toBe(values.b);
    expect(values.c).not.toBe(values.a);
    expect([values.a.snapshot.systemValue, values.c.snapshot.systemValue]).toEqual(["first", "second"]);
  } finally { await runtime.dispose(); }
});

test("generation composition rejects use before initialization and duplicate initialization", async () => {
  const runtime = gatewayRuntime({ dbPath: ":memory:" });
  try {
    await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const policyGeneration = seedKernelPolicyRows();
      yield* SessionHandleStore.materialize({ id: "init", parentId: null, role: "resident", tools: [],
        system: { preset: "", blocks: [] }, policyGeneration, actionId: "init-create", at: 1 });
      expect(yield* Effect.flip(generations.capture({ sessionId: "init", generation: 1 }))).toMatchObject({ operation: "generation.initialize", cause: "not_initialized" });
      yield* generations.initialize({ resident: [], worker: [] });
      expect(yield* Effect.flip(generations.initialize({ resident: [], worker: [] }))).toMatchObject({ operation: "generation.initialize", cause: "already_initialized" });
      expect(yield* Effect.flip(generations.capture({ sessionId: "init", generation: 99 }))).toMatchObject({ _tag: "GenerationUnavailable", generation: 99 });
    })));
  } finally { await runtime.dispose(); }
});

test("concurrent captures and hibernation reuse one owner; failed candidate acquisition and commit unwind without publication", async () => {
  const probe = { name: "probe.event", schema: z.object({ acquisition: z.number() }) };
  const acquired: number[] = [];
  const closed: number[] = [];
  const delivered: number[] = [];
  let fail = false;
  const live = Layer.scopedDiscard(Effect.gen(function* () {
    const sink = yield* ObservationSink;
    const id = yield* Effect.acquireRelease(Effect.sync(() => {
      const id = acquired.length + 1;
      acquired.push(id);
      const unsubscribe = sink.subscribe(probe, (event) => delivered.push(event.acquisition));
      sink.publish(probe, { acquisition: id });
      return { id, unsubscribe };
    }), ({ id, unsubscribe }) => Effect.sync(() => { unsubscribe(); closed.push(id); }));
    if (fail) return yield* new ForeignFailure({ operation: "fixture.acquire", cause: String(id.id) });
  }));
  const definition = bundle({ name: "probe", requires: [ObservationSink], provides: [], layer: live, events: [{ ns: "probe.event", version: 1 }] });
  const runtime = gatewayRuntime({ dbPath: ":memory:", bundles: BundlesLive([definition]) });
  try {
    const handle = await acquireAppResource(runtime, Effect.gen(function* () {
      yield* (yield* GenerationLayers).initialize({ resident: [], worker: [] });
      seedKernelPolicyRows();
      return yield* session({ id: "owners", role: "resident", bundles: ["probe"], runner: () => Effect.succeed({ kind: "result", text: "done" }) }, { authorizeConfigure: allowConfigure });
    }));
    const values = await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const captures = yield* Effect.all([generations.capture({ sessionId: handle.id, generation: 1 }), generations.capture({ sessionId: handle.id, generation: 1 })], { concurrency: "unbounded" });
      return yield* Effect.all(captures.map((capture) => capture.provide(SessionLayer)));
    })));
    expect(values[0]).toBe(values[1]);
    expect(acquired).toEqual([1]);
    await runAppEffect(runtime, handle.prompt("hibernate"));
    await runAppEffect(runtime, handle.prompt("rewake"));
    expect(acquired).toEqual([1]);
    fail = true;
    await expect(runAppEffect(runtime, handle.system.blocks.set([{ id: "two", source: "fixture", content: "candidate" }]))).rejects.toMatchObject({ _tag: "BundleError", code: "acquisition" });
    fail = false;
    expect(closed).toEqual([2]);
    expect(SessionHandleStore.latestGenerationFor(handle.id).generation).toBe(1);
    await runAppEffect(runtime, Effect.gen(function* () {
      const generations = yield* GenerationLayers;
      const before = SessionHandleStore.latestGenerationFor(handle.id);
      const failure = new ForeignFailure({ operation: "fixture.commit", cause: "refused" });
      expect(yield* Effect.flip(generations.configure({ sessionId: handle.id, generation: 2 }, { ...before, generation: 2 }, Effect.fail(failure)))).toBe(failure);
      expect(yield* Effect.flip(generations.configure({ sessionId: handle.id, generation: 3 }, before, Effect.void))).toMatchObject({ operation: "generation.configure" });
    }));
    expect(closed).toEqual([2, 3]);
    expect(delivered).toEqual([]);
    expect(await runAppEffect(runtime, handle.system.blocks.set([{ id: "two", source: "fixture", content: "committed" }]))).toMatchObject({ generation: 2 });
    expect(acquired).toEqual([1, 2, 3, 4]);
  } finally { await runtime.dispose(); }
  expect(closed.sort()).toEqual(acquired.sort());
});

for (const verdict of ["require_approval", "deny"] as const) {
  test(`configureAuthority refuses session.configure when the pinned pre-policy yields ${verdict}`, async () => {
    const runtime = gatewayRuntime({ dbPath: ":memory:" });
    try {
      const decisions = await runAppEffect(runtime, Effect.scoped(Effect.gen(function* () {
        const generations = yield* GenerationLayers;
        const policyGeneration = seedKernelPolicyRows([{
          name: `configure-${verdict}`, kind: "session.configure", phase: "pre", priority: 1_000,
          match: { encodingVersion: 1, value: { sessionId: "guarded" } },
          verdict: { encodingVersion: 1, value: verdict === "deny" ? { type: "deny", reason: "pinned" } : { type: "require_approval", reason: "pinned" } },
        }]);
        yield* generations.initialize({ resident: [], worker: [] });
        for (const id of ["guarded", "open"]) yield* SessionHandleStore.materialize({
          id, parentId: null, role: "resident", tools: [], system: { preset: id, blocks: [] },
          policyGeneration, actionId: `${id}-create`, at: 1,
        });
        const authority = configureAuthority(generations);
        return {
          guarded: yield* authority({ sessionId: "guarded", role: "resident", operation: "tools.add", generation: 1 }),
          open: yield* authority({ sessionId: "open", role: "resident", operation: "tools.add", generation: 1 }),
        };
      })));
      expect(decisions).toEqual({ guarded: false, open: true });
    } finally { await runtime.dispose(); }
  });
}
