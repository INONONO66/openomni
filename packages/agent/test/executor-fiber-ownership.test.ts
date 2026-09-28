import { testExecutor } from "./helpers/executor";
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { isolated } from "./helpers/isolated";
import { nativeExecutorOptions } from "./helpers/native-executor";

test("an unguarded action owns one body fiber and closes its scope before returning", () => isolated(Effect.scoped(Effect.gen(function* () {
  const executor = testExecutor(yield* nativeExecutorOptions());
  const bodyFibers = new Set<number>();
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let finalized = false;
  const running = yield* Effect.forkScoped(executor.run({
    kind: "tool", op: "read", intent: {}, effect: { category: "query" },
  }, () => Effect.gen(function* () {
    bodyFibers.add(yield* Effect.fiberId);
    yield* Effect.addFinalizer(() => Effect.sync(() => { finalized = true; }));
    yield* Deferred.succeed(entered, undefined);
    yield* Deferred.await(release);
    return "value";
  })));
  yield* Deferred.await(entered);
  expect(bodyFibers.size).toBe(1);
  expect(bodyFibers.has(running.id)).toBe(false);
  expect(finalized).toBe(false);
  yield* Deferred.succeed(release, undefined);
  expect(yield* Fiber.join(running)).toEqual({ terminal: "executed", value: "value" });
  expect(finalized).toBe(true);
}))));
