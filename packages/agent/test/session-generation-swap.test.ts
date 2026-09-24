import { testExecutor } from "./helpers/executor";
import { expect, test } from "bun:test";
import { SessionHandleStore } from "@openomni/ledger";
import type { AnyToolDefinition, SessionGeneration } from "@openomni/protocol";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { z } from "zod";
import { CommitFailed, PolicyDenied } from "../src/errors";
import { makeSessionGenerations, type GenerationBundle } from "../src/session-generations";
import { ObservationSink, SessionLayer, ToolCatalog } from "../src/services";
import { NamedPolicyRegistry } from "../src/bundle";
import { KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import { createObservationBus } from "../src/observation/bus";
import { executeToolBody } from "../src/tool-body";
import { effectValue, fiberSessionId, nativeExecutorOptions, nativePolicy } from "./helpers/native-executor";
import { isolated } from "./helpers/isolated";

function bundle(generation: number, name: string, finalized: () => void,
  execute: () => Promise<string> = async () => name): GenerationBundle {
  const definition: AnyToolDefinition = {
    name, description: name, category: "query", input: z.object({}), output: z.string(),
    visibility: { model: ["resident"], cell: [] }, execute,
    render: (_input, output) => String(output),
  };
  const snapshot = SessionHandleStore.generationSnapshot({
    generation, revertTo: generation - 1,
    tools: [{ name, category: "query", inputSchema: { type: "object", properties: {} } }],
    system: { preset: name, blocks: [] }, policyGeneration: 1,
  });
  return { id: { sessionId: fiberSessionId, generation }, snapshot, activate: Effect.void, layer: Layer.mergeAll(
    Layer.succeed(ObservationSink, createObservationBus()),
    Layer.succeed(NamedPolicyRegistry, KERNEL_POLICY_REGISTRY),
    Layer.succeed(SessionLayer, { snapshot, policy: nativePolicy }),
    Layer.succeed(ToolCatalog, { definitions: [definition] }),
    Layer.scopedDiscard(Effect.addFinalizer(() => Effect.sync(finalized))),
  ) };
}
function selectAction(snapshot: SessionGeneration.Snapshot) {
  return SessionHandleStore.configureAction({
    id: `generation:${snapshot.generation}`, sessionId: fiberSessionId,
    parentId: `${fiberSessionId}:turn`, operation: "system.blocks.set", snapshot, at: 100,
  });
}

const capturedBody = Effect.gen(function* () {
  const { snapshot } = yield* SessionLayer;
  const { definitions } = yield* ToolCatalog;
  const definition = definitions[0];
  if (definition === undefined) return yield* Effect.die("missing captured tool");
  const output = yield* executeToolBody(definition, {}, {
    sessionId: fiberSessionId, turnId: `${fiberSessionId}:turn`, callId: snapshot.systemValue,
    signal: new AbortController().signal,
  }, undefined);
  const stillCaptured = yield* SessionLayer;
  return { generation: stillCaptured.snapshot.generation, system: stillCaptured.snapshot.systemValue, output };
});

test("committed configure swaps the next captured Layer; old body and terminal stay A until its finalizer", () => isolated(Effect.scoped(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const entered = yield* Deferred.make<void>();
  const finishedA = yield* Deferred.make<void>();
  const release = Promise.withResolvers<string>();
  let finalizersA = 0;
  const a = bundle(1, "A", () => { finalizersA += 1; Deferred.unsafeDone(finishedA, Exit.void); }, async () => {
    Deferred.unsafeDone(entered, Exit.void);
    return release.promise;
  });
  const b = bundle(2, "B", () => undefined);
  const generations = yield* makeSessionGenerations(a);
  const executeCaptured = Effect.scoped(Effect.gen(function* () {
    const captured = yield* generations.capture();
    const executor = testExecutor({ ...options, identity: {
      ...options.identity, toolsGeneration: captured.snapshot.generation, systemHash: captured.snapshot.systemHash,
    } });
    return yield* captured.provide(executor.run({
      kind: "tool", op: captured.snapshot.systemValue, intent: {}, effect: {},
    }, () => capturedBody));
  }));
  const running = yield* Effect.fork(executeCaptured);
  yield* Deferred.await(entered);
  yield* generations.configure(b, options.ledger.commit(selectAction(b.snapshot)).pipe(
    Effect.mapError((error) => new CommitFailed({ error })),
  ));
  expect(SessionHandleStore.latestGeneration(SessionHandleStore.tree(fiberSessionId)).generation).toBe(2);
  expect(finalizersA).toBe(0);
  release.resolve("A-result");
  expect(yield* Fiber.join(running)).toEqual({ terminal: "executed", value: {
    generation: 1, system: "A", output: { status: "success", output: "A-result" },
  } });
  yield* Deferred.await(finishedA);
  expect(finalizersA).toBe(1);
  expect(yield* executeCaptured).toEqual({ terminal: "executed", value: {
    generation: 2, system: "B", output: { status: "success", output: "B" },
  } });
  expect(SessionHandleStore.tree(fiberSessionId).filter((action) =>
    action.kind === "tool" && effectValue(action).phase === "result").map(effectValue))
    .toMatchObject([{ terminal: "executed", result: { generation: 1, system: "A" } },
      { terminal: "executed", result: { generation: 2, system: "B" } }]);
}))));

test("failed configure leaves selection unchanged; unavailable generations fail closed; revert appends a selection", () => isolated(Effect.scoped(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const a = bundle(1, "A", () => undefined);
  const generations = yield* makeSessionGenerations(a);
  const failed = yield* Effect.either(generations.configure(bundle(2, "B", () => undefined),
    Effect.fail(new PolicyDenied({ phase: "pre", ruleIds: ["configure-denied"] }))));
  expect(failed).toMatchObject({ _tag: "Left", left: { _tag: "PolicyDenied", phase: "pre", ruleIds: ["configure-denied"] } });
  expect((yield* Effect.scoped(generations.capture())).snapshot.systemValue).toBe("A");
  for (const selected of [bundle(2, "B", () => undefined), bundle(3, "A", () => undefined)]) {
    yield* generations.configure(selected, options.ledger.commit(selectAction(selected.snapshot)).pipe(
      Effect.mapError((error) => new CommitFailed({ error })),
    ));
    expect(yield* Effect.either(generations.capture(a))).toMatchObject({ _tag: "Left", left: { _tag: "GenerationUnavailable", generation: 1 } });
  }
  const reverted = yield* generations.capture();
  expect(reverted.snapshot).toMatchObject({ generation: 3, revertTo: 2, systemValue: "A" });
  expect(SessionHandleStore.tree(fiberSessionId).filter((action) => action.kind === "session.configure")).toHaveLength(3);
}))));

test("retired generation stays acquired after interrupted fiber until its raw slot actually settles", () => isolated(Effect.scoped(Effect.gen(function* () {
  const options = yield* nativeExecutorOptions();
  const entered = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const release = Promise.withResolvers<string>();
  let finalized = 0;
  const generations = yield* makeSessionGenerations(bundle(1, "A", () => {
    finalized += 1; Deferred.unsafeDone(closed, Exit.void);
  }, async () => { Deferred.unsafeDone(entered, Exit.void); return release.promise; }));
  const running = yield* Effect.fork(Effect.scoped(Effect.gen(function* () {
    const captured = yield* generations.capture();
    return yield* captured.provide(testExecutor({ ...options, closeGraceMs: 0 }).run({
      kind: "tool", op: "A", intent: {}, effect: {},
    }, () => capturedBody));
  })));
  yield* Deferred.await(entered);
  const b = bundle(2, "B", () => undefined);
  yield* generations.configure(b, options.ledger.commit(selectAction(b.snapshot)).pipe(
    Effect.mapError((error) => new CommitFailed({ error })),
  ));
  yield* Fiber.interrupt(running);
  expect(finalized).toBe(0);
  expect(SessionHandleStore.tree(fiberSessionId).filter((action) =>
    action.kind === "tool" && effectValue(action).phase === "result").map(effectValue))
    .toMatchObject([{ terminal: "outcome_unknown" }]);
  release.resolve("late");
  yield* Deferred.await(closed);
  expect(finalized).toBe(1);
}))));
