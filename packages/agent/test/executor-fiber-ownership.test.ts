import type { ResolvedExecutorOptions } from "../src/executor-contract";
import { executorLayer } from "./helpers/service-layers";
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Supervisor } from "effect";
import { createExecutor } from "../src/executor";
import { isolated } from "./helpers/isolated";
import { nativeExecutorOptions } from "./helpers/native-executor";

test("an unguarded action owns one body fiber and closes its scope before returning", () => isolated(Effect.scoped(Effect.gen(function* () {
  const executor = Effect.runSync(Effect.gen(function* () { const { policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy, ...executorOptions }: ResolvedExecutorOptions = yield* nativeExecutorOptions(); return yield* createExecutor(executorOptions).pipe(Effect.provide(executorLayer({ policy: capturedPolicy, observations: capturedObservations, clock: capturedClock, entropy: capturedEntropy }))); }));
  const supervisor = yield* Supervisor.track;
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let finalized = false;
  const running = yield* Effect.forkScoped(executor.run({
    kind: "tool", op: "read", intent: {}, effect: { category: "query" },
  }, () => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true; }));
    yield* Deferred.succeed(entered, undefined);
    yield* Deferred.await(release);
    return "value";
  })).pipe(Effect.supervised(supervisor)));
  yield* Deferred.await(entered);
  expect(yield* supervisor.value).toHaveLength(1);
  expect(finalized).toBe(false);
  yield* Deferred.succeed(release, undefined);
  expect(yield* Fiber.join(running)).toEqual({ terminal: "executed", value: "value" });
  expect(finalized).toBe(true);
}))));
