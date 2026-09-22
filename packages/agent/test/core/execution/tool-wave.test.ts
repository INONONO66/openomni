import { expect, it } from "bun:test";
import type { LedgerAction, ToolExecutionContext } from "@openomni/protocol";
import { Effect, Fiber } from "effect";
import { createExecutor, type ExecutorOptions } from "../../../src/executor";
import { createRawSlots } from "../../../src/executor-raw";
import { GenerationRawSlots } from "../../../src/session-generations";
import { createDispatcher } from "../../../src/tool-dispatcher";
import { executeToolBody } from "../../../src/tool-body";
import { ForeignFailure } from "../../../src/errors";
import { allowAllPolicy } from "../../helpers/compiled-policy";
import { recordingLedger } from "../../helpers/effect-g2";
import { bounded } from "../../helpers/bounded";
import { isolated } from "../../helpers/isolated";
import { timedQueryTool } from "../../helpers/query-tool";

const request = { kind: "tool", op: "test", intent: {}, effect: {} };
const call = { id: "timed-call", tool: "timed", input: {} };
const context = { sessionId: "session-1", turnId: "turn-1" };
function recording(overrides: Partial<ExecutorOptions> = {}) {
  const record = recordingLedger();
  return {
    ...record,
    executor: createExecutor({
      policy: allowAllPolicy,
      ledger: record.ledger,
      observations: { publish: () => undefined },
      identity: { sessionId: "session-1", role: "resident", parentActionId: null },
      clock: () => 1,
      entropy: record.entropy,
      closeGraceMs: 0,
      ...overrides,
    }),
  };
}
function toolResults(actions: readonly LedgerAction.Append[]) {
  return actions.filter((action: LedgerAction.Append) => {
    const value = action.effect.value;
    return action.kind === "tool" && value !== null && typeof value === "object" && !Array.isArray(value) && value.phase === "result";
  });
}

for (const door of ["cell", "wave"] as const) {
  for (const owner of ["bound", "generation"] as const) {
    it(`fulfills ${owner} ownership after timed ${door} rejection`, () => isolated(Effect.scoped(Effect.gen(function* () {
      const gate = Promise.withResolvers<void>();
      const timedOut = Promise.withResolvers<void>();
      const effects = new Set<Promise<void>>();
      const observers: Promise<void>[] = [];
      const rejectedOwnership: Error[] = [];
      let foreignRetentions = 0;
      let rawSettled = false;
      const retain = (effect: Promise<void>) => {
        effects.add(effect);
        observers.push(effect.then(
          () => { effects.delete(effect); },
          (error: Error) => { rejectedOwnership.push(error); },
        ));
      };
      const generation = createRawSlots(owner === "generation" ? retain : undefined);
      const record = recording(owner === "bound" ? { retainEffect: retain } : {});
      const dispatcher = createDispatcher([
        timedQueryTool("actual timed rejection", async (_input: Record<string, never>, execution: ToolExecutionContext) => {
          execution.signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
          await gate.promise;
          rawSettled = true;
          throw new Error("raw definition rejected");
        }),
      ], {
        executor: record.executor,
        timeoutMs: 0,
        retainEffect: () => { foreignRetentions += 1; },
      });
      const work = Effect.gen(function* () {
        return door === "cell"
          ? [yield* dispatcher.executeCell(call, context)]
          : yield* dispatcher.executeWave([call], context);
      });
      const wrapper = yield* Effect.forkScoped(work.pipe(Effect.provideService(GenerationRawSlots, generation)));
      try {
        yield* Effect.promise(() => bounded(timedOut.promise));
        const results = yield* Fiber.join(wrapper);
        const frozen = structuredClone(results);
        expect(results).toMatchObject([{ isError: true, errorKind: "execution_failed" }]);
        expect(record.committed.at(-1)?.effect.value).toMatchObject({
          terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace",
        });
        expect(rawSettled).toBe(false);
        expect(foreignRetentions).toBe(0);
        expect(effects.size).toBe(1);
        const actionCount = record.committed.length;
        const pending = [...effects];
        gate.resolve();
        const settlement = yield* Effect.promise(() => bounded(Promise.allSettled(pending)));
        yield* Effect.promise(() => bounded(Promise.all(observers)));
        expect(rawSettled).toBe(true);
        expect(results).toEqual(frozen);
        expect(record.committed).toHaveLength(actionCount);
        expect(settlement.map((result: PromiseSettledResult<void>) => result.status)).toEqual(["fulfilled"]);
        expect(rejectedOwnership).toEqual([]);
        expect(effects.size).toBe(0);
        expect(generation.pending()).toBe(0);
      } finally {
        gate.resolve();
        yield* Fiber.await(wrapper);
        yield* Effect.promise(() => bounded(Promise.all(observers)));
      }
    }))), 15000);
  }

  it(`reports timed ${door} rejection before timeout`, () => isolated(Effect.gen(function* () {
    const record = recording();
    const dispatcher = createDispatcher([
      timedQueryTool("immediate rejection", async () => { throw new Error("raw definition rejected"); }),
    ], { executor: record.executor, timeoutMs: 0 });
    const results = door === "cell"
      ? [yield* dispatcher.executeCell(call, context)]
      : yield* dispatcher.executeWave([call], context);
    expect(results).toMatchObject([{ isError: true, errorKind: "execution_failed" }]);
    expect(record.committed.at(-1)?.effect.value).toMatchObject({
      terminal: "executed",
      evidence: { failures: [{ tag: "ToolBodyFailed", cause: "Error: raw definition rejected" }] },
    });
  })));

  for (const rejects of [false, true]) {
    it(`inherits generation retention into a timed ${door} definition that ${rejects ? "rejects" : "fulfills"}`, () => isolated(Effect.scoped(Effect.gen(function* () {
      const gate = Promise.withResolvers<void>();
      const timedOut = Promise.withResolvers<void>();
      const generation = createRawSlots();
      const dispatcher = createDispatcher([
        timedQueryTool("timed effect", async (_input: Record<string, never>, execution: ToolExecutionContext) => {
          execution.signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
          await gate.promise;
          if (rejects) throw new Error("raw effect rejected");
          return "effect";
        }),
      ], { executor: recording().executor, timeoutMs: 0 });
      const wave = yield* Effect.forkScoped(Effect.gen(function* () {
        const results = door === "cell"
          ? [yield* dispatcher.executeCell(call, context)]
          : yield* dispatcher.executeWave([call], context);
        expect(results.map((result: { readonly isError?: boolean }) => result.isError)).toEqual([true]);
      }).pipe(Effect.provideService(GenerationRawSlots, generation)));
      try {
        yield* Effect.promise(() => bounded(timedOut.promise));
        yield* Fiber.join(wave);
        expect(generation.pending()).toBe(1);
        gate.resolve();
        yield* generation.awaitSettled.pipe(Effect.timeout("5 seconds"));
        expect(generation.pending()).toBe(0);
      } finally {
        gate.resolve();
        yield* Fiber.await(wave);
        yield* generation.awaitSettled.pipe(Effect.timeout("5 seconds"));
      }
    }))), 15000);
  }
}

it("inherits raw-body retention through nested executors without a bound turn owner", () => isolated(Effect.scoped(Effect.gen(function* () {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<string>();
  const generation = createRawSlots();
  const outer = recording({ signal: controller.signal });
  const inner = recording({ signal: controller.signal });
  const definition = timedQueryTool("nested raw body", () => {
    entered.resolve();
    return gate.promise;
  });
  const wave = yield* Effect.forkScoped(outer.executor.run(request, () => inner.executor.runBatch([{
    request,
    body: () => executeToolBody(definition, {}, { ...context, callId: call.id, signal: controller.signal }, undefined),
  }], { signal: controller.signal }).pipe(Effect.as(null))).pipe(Effect.provideService(GenerationRawSlots, generation)));
  try {
    yield* Effect.promise(() => bounded(entered.promise));
    controller.abort();
    expect(yield* Fiber.join(wave)).toMatchObject({ terminal: "interrupted" });
    expect(toolResults(inner.committed).map((action: LedgerAction.Append) => action.effect.value)).toMatchObject([
      { terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace" },
    ]);
    // Only the actual foreign definition owns a raw slot, not its executor wrappers.
    expect(generation.pending()).toBe(1);
  } finally {
    gate.resolve("late");
    yield* Fiber.await(wave);
    yield* generation.awaitSettled.pipe(Effect.timeout("5 seconds"));
  }
}))));

it("freezes unsettled slots as interrupted at the abort event, even if a body resolves in that event", () => isolated(Effect.scoped(Effect.gen(function* () {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<{ late: boolean }>();
  const record = recording();
  const pending = yield* Effect.forkScoped(record.executor.runBatch([{
    request,
    body: () => Effect.promise(() => {
      controller.signal.addEventListener("abort", () => result.resolve({ late: true }), { once: true });
      entered.resolve();
      return result.promise;
    }),
  }], { signal: controller.signal }));
  yield* Effect.promise(() => bounded(entered.promise));
  controller.abort();
  expect(yield* Fiber.join(pending)).toEqual([{ terminal: "interrupted", reason: "fiber_interrupted" }]);
}))));

for (const settlement of ["fulfillment", "rejection"] as const) {
  it(`does not let a late body ${settlement} overwrite cancellation`, () => isolated(Effect.scoped(Effect.gen(function* () {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const effects: Promise<void>[] = [];
    const record = recording({ retainEffect: (effect: Promise<void>) => { effects.push(effect); } });
    const definition = timedQueryTool("late settlement", () => {
      entered.resolve();
      return release.promise;
    });
    const wave = yield* Effect.forkScoped(record.executor.runBatch([{
      request,
      body: () => executeToolBody(definition, {}, { ...context, callId: call.id, signal: controller.signal }, undefined),
    }], { signal: controller.signal }));
    try {
      yield* Effect.promise(() => bounded(entered.promise));
      controller.abort();
      const results = yield* Fiber.join(wave);
      expect(results).toEqual([{ terminal: "outcome_unknown", reason: "raw_body_unsettled_after_grace" }]);
      const frozen = structuredClone(record.committed);
      expect(effects).toHaveLength(1);
      if (settlement === "rejection") release.reject(new Error("late rejection"));
      else release.resolve("late");
      expect(yield* Effect.promise(() => bounded(Promise.allSettled(effects)))).toEqual([
        { status: "fulfilled", value: undefined },
      ]);
      expect(record.committed).toEqual(frozen);
      expect(yield* Fiber.join(wave)).toEqual(results);
    } finally {
      release.resolve("late");
      yield* Fiber.await(wave);
      yield* Effect.promise(() => bounded(Promise.allSettled(effects)));
    }
  }))));
}

it("does not enter a body when cancellation predates the wave", () => isolated(Effect.gen(function* () {
  const controller = new AbortController();
  controller.abort();
  let entered = 0;
  const results = yield* recording().executor.runBatch([{
    request,
    body: () => Effect.sync(() => { entered += 1; return null; }),
  }], { signal: controller.signal });
  expect(results).toEqual([{ terminal: "interrupted", reason: "fiber_interrupted" }]);
  expect(entered).toBe(0);
})));

it("keeps a sequential barrier after preceding rejection and runs later work", () => isolated(Effect.gen(function* () {
  const entered: string[] = [];
  const failure = new ForeignFailure({ operation: "parallel", cause: "parallel failed" });
  const results = yield* recording().executor.runBatch([
    { request, body: () => Effect.sync(() => { entered.push("parallel"); }).pipe(Effect.zipRight(Effect.fail(failure))) },
    { request, sequential: true, body: () => Effect.sync(() => { entered.push("barrier"); return null; }) },
    { request, body: () => Effect.sync(() => { entered.push("following"); return null; }) },
  ], { signal: new AbortController().signal });
  expect(results).toEqual([
    { terminal: "executed", value: null, failure },
    { terminal: "executed", value: null },
    { terminal: "executed", value: null },
  ]);
  expect(entered).toEqual(["parallel", "barrier", "following"]);
})));

it("joins preceding work and blocks following work at a sequential barrier", () => isolated(Effect.scoped(Effect.gen(function* () {
  const first = Promise.withResolvers<null>();
  const barrier = Promise.withResolvers<null>();
  const firstEntered = Promise.withResolvers<void>();
  const barrierEntered = Promise.withResolvers<void>();
  const entered: string[] = [];
  const wave = yield* Effect.forkScoped(recording().executor.runBatch([
    { request, body: () => Effect.promise(() => { entered.push("A"); firstEntered.resolve(); return first.promise; }) },
    { request, sequential: true, body: () => Effect.promise(() => { entered.push("D"); barrierEntered.resolve(); return barrier.promise; }) },
    { request, body: () => Effect.sync(() => { entered.push("E"); return null; }) },
  ], { signal: new AbortController().signal }));
  try {
    yield* Effect.promise(() => bounded(firstEntered.promise));
    expect(entered).toEqual(["A"]);
    first.resolve(null);
    yield* Effect.promise(() => bounded(barrierEntered.promise));
    expect(entered).toEqual(["A", "D"]);
    barrier.resolve(null);
    yield* Fiber.join(wave);
    expect(entered).toEqual(["A", "D", "E"]);
  } finally {
    first.resolve(null);
    barrier.resolve(null);
    yield* Fiber.await(wave);
  }
}))));
