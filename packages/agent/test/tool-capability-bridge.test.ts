import { expect, test } from "bun:test";
import { SessionHandleStore, type LedgerError } from "@openomni/ledger";
import { KERNEL_POLICY_REGISTRY } from "@openomni/policy";
import type { AnyToolDefinition, LedgerAction, PlainValue, ToolExecutionContext } from "@openomni/protocol";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Scope } from "effect";
import { z } from "zod";
import { NamedPolicyRegistry } from "../src/bundle";
import { CommitFailed, ToolBodyFailed, type ExecutionError } from "../src/errors";
import { currentInvocation } from "../src/executor-context";
import type { ExecutionResult } from "../src/executor-contract";
import { createObservationBus } from "../src/observation/bus";
import { GenerationRawSlots, makeSessionGenerations, type GenerationBundle } from "../src/session-generations";
import { ObservationSink, SessionLayer, ToolCatalog } from "../src/services";
import { createTurnDispatcher, sessionTool } from "../src/tool-dispatcher";
import { runAgent } from "./helpers/executor";
import { isolated } from "./helpers/isolated";
import { effectValue, fiberSessionId, nativeExecutorOptions, nativePolicy } from "./helpers/native-executor";
import { sessionTree } from "../../ledger/test/helpers/session-tree";

const context = { sessionId: fiberSessionId, turnId: `${fiberSessionId}:turn` };
const request = (op: string) => ({ kind: "tool", op, intent: {}, effect: { category: "query" } });
const awaitSignal = <A, E>(signal: Deferred.Deferred<A, E>) => Deferred.await(signal).pipe(Effect.timeout("5 seconds"));
function failure<A, E>(exit: Exit.Exit<A, E>): E | undefined {
  return Exit.isFailure(exit) ? Option.getOrUndefined(Cause.failureOption(exit.cause)) : undefined;
}
function tool(name: string, execute: (input: PlainValue, context: ToolExecutionContext) => Promise<string>): AnyToolDefinition {
  return { name, description: name, category: "query", input: z.object({}), output: z.string(),
    visibility: { model: ["resident"], cell: ["resident"] }, execute,
    render: (_input: PlainValue, output: PlainValue) => String(output) };
}
function bundle(generation: number, definitions: readonly AnyToolDefinition[], bus: ReturnType<typeof createObservationBus>): GenerationBundle {
  const snapshot = SessionHandleStore.generationSnapshot({ generation, revertTo: generation - 1,
    tools: definitions.map((definition: AnyToolDefinition) => sessionTool(definition)),
    system: { preset: "bridge", blocks: [] }, policyGeneration: 1 });
  return { id: { sessionId: fiberSessionId, generation }, snapshot, activate: Effect.void,
    layer: Layer.mergeAll(Layer.succeed(ObservationSink, bus), Layer.succeed(NamedPolicyRegistry, KERNEL_POLICY_REGISTRY),
      Layer.succeed(SessionLayer, { snapshot, policy: nativePolicy }), Layer.succeed(ToolCatalog, { definitions })) };
}
function setup(definitions: readonly AnyToolDefinition[], signal?: AbortSignal) {
  return Effect.gen(function* () {
    const options = yield* nativeExecutorOptions();
    const bus = createObservationBus();
    const generations = yield* makeSessionGenerations(bundle(1, definitions, bus));
    const captureScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(captureScope, Exit.void));
    const captured = yield* generations.capture().pipe(Effect.provideService(Scope.Scope, captureScope));
    const dispatcher = yield* captured.provide(createTurnDispatcher({ ...options.identity, actionId: context.turnId,
      ledger: options.ledger, tools: captured.snapshot.tools, toolsGeneration: 1, signal,
      toolsHash: captured.snapshot.toolsHash, systemHash: captured.snapshot.systemHash }, { closeGraceMs: 0 }));
    const slots = yield* captured.provide(GenerationRawSlots);
    return { options, bus, generations, captured, dispatcher, captureScope, slots,
      run: captured.provide(dispatcher.execute({ id: "outer", tool: "outer", input: {} }, context)) };
  });
}

test("bridge: nested failure in an admitted async body preserves its typed outcome, not ForeignFailure", () => isolated(Effect.gen(function* () {
  const observed = yield* Deferred.make<Exit.Exit<ExecutionResult, ExecutionError>>();
  const fixture = yield* setup([tool("outer", async () => {
    const frame = currentInvocation();
    const result = await runAgent(Effect.exit(frame.executor.run(request("nested"), () =>
      Effect.fail(new ToolBodyFailed({ tool: "nested", cause: "nested-outcome" })))));
    Deferred.unsafeDone(observed, Exit.succeed(result));
    return "handled";
  })]);
  expect(yield* fixture.run).toMatchObject({ output: "handled" });
  const result = yield* awaitSignal(observed);
  expect(failure(result)).toMatchObject({ _tag: "ToolBodyFailed", tool: "nested", cause: "nested-outcome" });
  expect(failure(result)).not.toMatchObject({ _tag: "ForeignFailure" });
  expect(sessionTree(fiberSessionId).filter((action: LedgerAction.Node) => action.kind === "tool").map(effectValue))
    .toContainEqual(expect.objectContaining({ phase: "result", evidence: expect.objectContaining({
      failures: [expect.objectContaining({ tag: "ToolBodyFailed" })],
    }) }));
})));

test("bridge: two concurrent nested calls resolve independently in call order", () => isolated(Effect.gen(function* () {
  const firstEntered = yield* Deferred.make<void>();
  const secondEntered = yield* Deferred.make<void>();
  const first = yield* Deferred.make<string>();
  const second = yield* Deferred.make<string>();
  const secondReplied = yield* Deferred.make<void>();
  const replies: string[] = [];
  const fixture = yield* setup([tool("outer", async () => {
    const frame = currentInvocation();
    const one = runAgent(frame.executor.run(request("one"), () => Deferred.succeed(firstEntered, undefined).pipe(
      Effect.andThen(Deferred.await(first))))).then((result: ExecutionResult) => { replies.push("one"); return result; });
    const two = runAgent(frame.executor.run(request("two"), () => Deferred.succeed(secondEntered, undefined).pipe(
      Effect.andThen(Deferred.await(second))))).then((result: ExecutionResult) => {
        replies.push("two"); Deferred.unsafeDone(secondReplied, Exit.void); return result;
      });
    const results = await Promise.all([one, two]);
    expect(results).toEqual([{ terminal: "executed", value: "first" }, { terminal: "executed", value: "second" }]);
    return "both";
  })]);
  const running = yield* Effect.forkScoped(fixture.run);
  yield* awaitSignal(firstEntered);
  yield* awaitSignal(secondEntered);
  yield* Deferred.succeed(second, "second");
  yield* awaitSignal(secondReplied);
  expect(replies).toEqual(["two"]);
  yield* Deferred.succeed(first, "first");
  expect(yield* Fiber.join(running)).toMatchObject({ output: "both" });
  expect(replies).toEqual(["two", "one"]);
})));

test("bridge: closing the executor rejects every pending nested request with InvocationClosed", () => isolated(Effect.gen(function* () {
  const closing = new AbortController();
  const enteredOne = yield* Deferred.make<void>();
  const enteredTwo = yield* Deferred.make<void>();
  const replies = yield* Deferred.make<readonly Exit.Exit<ExecutionResult, ExecutionError>[]>();
  const fixture = yield* setup([tool("outer", async () => {
    const frame = currentInvocation();
    const pending = [enteredOne, enteredTwo].map((entered: Deferred.Deferred<void>, index: number) =>
      runAgent(Effect.exit(frame.executor.run(request(`pending-${index}`), () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))))));
    const results = await Promise.all(pending);
    Deferred.unsafeDone(replies, Exit.succeed(results));
    return "closed";
  })], closing.signal);
  const running = yield* Effect.forkScoped(fixture.run);
  yield* awaitSignal(enteredOne);
  yield* awaitSignal(enteredTwo);
  closing.abort();
  const results = yield* awaitSignal(replies);
  expect(results).toHaveLength(2);
  for (const result of results) expect(failure(result)).toMatchObject({ _tag: "InvocationClosed", tool: "outer", reason: "interrupted" });
  expect(yield* Fiber.join(running)).toMatchObject({ isError: true });
})));

test("bridge: cancel-before-reply interrupts the body and late nested reply performs zero ledger effects", () => isolated(Effect.gen(function* () {
  const closing = new AbortController();
  const entered = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  const rawSettled = yield* Deferred.make<void>();
  const rejected = yield* Deferred.make<ExecutionError | undefined>();
  const reply = Promise.withResolvers<string>();
  const fixture = yield* setup([
    tool("outer", async () => {
      const frame = currentInvocation();
      const result = await runAgent(Effect.exit(frame.cell.executeCell({ id: "nested", tool: "inner", input: {} }, context)));
      Deferred.unsafeDone(rejected, Exit.succeed(failure(result)));
      return "cancelled";
    }),
    tool("inner", async (_input: PlainValue, call: ToolExecutionContext) => {
      call.signal.addEventListener("abort", () => { Deferred.unsafeDone(interrupted, Exit.void); }, { once: true });
      Deferred.unsafeDone(entered, Exit.void);
      const value = await reply.promise;
      Deferred.unsafeDone(rawSettled, Exit.void);
      return value;
    }),
  ]);
  yield* Effect.addFinalizer(() => Effect.sync(() => reply.resolve("cleanup")));
  const running = yield* Effect.forkScoped(fixture.captured.provide(fixture.dispatcher.execute(
    { id: "outer", tool: "outer", input: {} }, { ...context, signal: closing.signal },
  )));
  yield* awaitSignal(entered);
  closing.abort();
  yield* awaitSignal(interrupted);
  expect(yield* awaitSignal(rejected)).toMatchObject({ _tag: "InvocationClosed", reason: "interrupted" });
  expect(yield* Fiber.join(running)).toMatchObject({ isError: true });
  const before = sessionTree(fiberSessionId);
  reply.resolve("late");
  yield* awaitSignal(rawSettled);
  yield* Scope.close(fixture.captureScope, Exit.void);
  yield* fixture.slots.awaitSettled.pipe(Effect.timeout("5 seconds"));
  expect(sessionTree(fiberSessionId)).toEqual(before);
  expect(before.filter((action: LedgerAction.Node) => action.kind === "tool" && effectValue(action).phase === "result")
    .map(effectValue)).toContainEqual(expect.objectContaining({ callId: "outer", evidence: expect.objectContaining({ interrupted: true }) }));
  expect(before.filter((action: LedgerAction.Node) => action.kind === "tool" && effectValue(action).phase === "result")
    .map(effectValue)).not.toContainEqual(expect.objectContaining({ callId: "nested", terminal: "executed" }));
})));

test("bridge: detached late requests after settle fail with InvocationClosed and execute nothing", () => isolated(Effect.gen(function* () {
  const ready = yield* Deferred.make<readonly Effect.Effect<PlainValue, ExecutionError>[]>();
  let bodies = 0;
  const fixture = yield* setup([
    tool("outer", async () => {
      const frame = currentInvocation();
      Deferred.unsafeDone(ready, Exit.succeed([
        frame.executor.run(request("detached"), () => Effect.sync(() => { bodies += 1; return "forbidden"; })).pipe(Effect.as("done")),
        frame.cell.executeCell({ id: "detached-cell", tool: "inner", input: {} }, context).pipe(Effect.as("done")),
      ]));
      return "settled";
    }),
    tool("inner", async () => { bodies += 1; return "forbidden"; }),
  ]);
  expect(yield* fixture.run).toMatchObject({ output: "settled" });
  const pending = yield* awaitSignal(ready);
  const before = sessionTree(fiberSessionId);
  for (const work of pending) expect(failure(yield* Effect.exit(work))).toMatchObject({ _tag: "InvocationClosed", tool: "outer", reason: "settled" });
  expect(bodies).toBe(0);
  expect(sessionTree(fiberSessionId)).toEqual(before);
})));

test("bridge: generation-one frame refuses nested dispatch after committed generation-two selection", () => isolated(Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const selected = Promise.withResolvers<void>();
  const observed = yield* Deferred.make<ExecutionError | undefined>();
  let bodies = 0;
  const definitions = [tool("outer", async () => {
    const frame = currentInvocation();
    Deferred.unsafeDone(entered, Exit.void);
    await selected.promise;
    const before = sessionTree(fiberSessionId);
    const result = await runAgent(Effect.exit(frame.cell.executeCell({ id: "stale", tool: "inner", input: {} }, context)));
    expect(sessionTree(fiberSessionId)).toEqual(before);
    Deferred.unsafeDone(observed, Exit.succeed(failure(result)));
    return "old-outer-settled";
  }), tool("inner", async () => { bodies += 1; return "forbidden"; })];
  const fixture = yield* setup(definitions);
  const running = yield* Effect.forkScoped(fixture.run);
  yield* awaitSignal(entered);
  const next = bundle(2, definitions, fixture.bus);
  yield* fixture.generations.configure(next, fixture.options.ledger.commit(SessionHandleStore.configureAction({
    id: "configure-two", sessionId: fiberSessionId, parentId: context.turnId,
    operation: "system.blocks.set", snapshot: next.snapshot, at: 100,
  })).pipe(Effect.mapError((error: LedgerError) => new CommitFailed({ error })))).pipe(
    Effect.ensuring(Effect.sync(() => selected.resolve())),
  );
  expect(yield* awaitSignal(observed)).toMatchObject({ _tag: "GenerationUnavailable", generation: 1 });
  expect(bodies).toBe(0);
  expect(SessionHandleStore.latestGenerationFor(fiberSessionId).generation).toBe(2);
  expect(yield* Fiber.join(running)).toMatchObject({ output: "old-outer-settled" });
  expect(sessionTree(fiberSessionId).filter((action: LedgerAction.Node) => action.kind === "tool" && action.intent.value !== null &&
    typeof action.intent.value === "object" && !Array.isArray(action.intent.value) && action.intent.value.callId === "stale")).toHaveLength(0);
  yield* Scope.close(fixture.captureScope, Exit.void);
})));
