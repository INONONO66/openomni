import { expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit, Fiber } from "effect";
import { onAbort } from "../src/interrupt-on";
import { exit as runExit } from "./helpers/effect";

test("onAbort resumes with the success outcome when the signal aborts", async () => {
  const controller = new AbortController();
  const exit = await runExit(Effect.scoped(Effect.gen(function* () {
    const waiter = yield* Effect.forkScoped(onAbort(controller.signal, Effect.succeed("aborted")));
    yield* Effect.sync(() => controller.abort());
    return yield* Fiber.join(waiter);
  })));
  expect(exit).toEqual(Exit.succeed("aborted"));
});

test("onAbort resumes with a typed failure outcome", async () => {
  const exit = await runExit(onAbort(AbortSignal.abort(), Effect.fail("cancelled" as const)));
  expect(exit).toEqual(Exit.fail("cancelled"));
});

test("interrupting the waiter before abort detaches the listener", async () => {
  const controller = new AbortController();
  const removed = spyOn(controller.signal, "removeEventListener");
  const exit = await runExit(Effect.scoped(Effect.gen(function* () {
    // Observed through a promise continuation so the waiter's cleanup is installed before the interrupt.
    const registered = Promise.withResolvers<void>();
    const addEventListener = controller.signal.addEventListener.bind(controller.signal);
    const added = spyOn(controller.signal, "addEventListener").mockImplementation((...args: Parameters<AbortSignal["addEventListener"]>) => {
      addEventListener(...args);
      registered.resolve();
    });
    const waiter = yield* Effect.forkScoped(onAbort(controller.signal, Effect.void));
    yield* Effect.promise(() => registered.promise);
    added.mockRestore();
    yield* Fiber.interrupt(waiter);
    return yield* Fiber.await(waiter);
  })));
  expect(Exit.isSuccess(exit) && Exit.isFailure(exit.value) && Cause.hasInterruptsOnly(exit.value.cause)).toBe(true);
  controller.abort();
  expect(removed).toHaveBeenCalledTimes(1);
  removed.mockRestore();
});
