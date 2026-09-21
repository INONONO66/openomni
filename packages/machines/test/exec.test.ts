import { expect, test } from "bun:test";
import { Machine } from "@openomni/protocol";
import { Effect, Fiber, Cause, Exit, TestClock, TestContext } from "effect";
import { execute as nativeExecute } from "../src/exec";

const request = { cmd: "while :; do :; done", cwd: "/" };

test("aborting a shell interrupts and waits for its process group to close", async () => {
  const controller = new AbortController();
  const fiber = Effect.runFork(nativeExecute(request, controller.signal));
  controller.abort();
  const exit = await Effect.runPromise(Fiber.await(fiber));
  expect(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)).toBe(true);
  const preAborted = await Effect.runPromiseExit(nativeExecute(request, controller.signal));
  expect(Exit.isFailure(preAborted) && Cause.isInterrupted(preAborted.cause)).toBe(true);
});

test("the execution deadline kills the real shell and settles timed_out", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(nativeExecute(request, new AbortController().signal));
    yield* TestClock.adjust(Machine.EXEC_TIMEOUT_MS);
    return yield* Fiber.join(fiber);
  })).pipe(Effect.provide(TestContext.TestContext)));
  expect(result).toEqual({ status: "timed_out" });
});
