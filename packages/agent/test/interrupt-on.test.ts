import { describe, expect, it, jest } from "bun:test";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { Interrupted } from "../src/errors";
import { interruptOn, onAbort } from "../src/core/interrupt-on";
import { runAgent, runAgentSync } from "./helpers/isolated";

/** A real signal whose listener registrations are observable. */
function trackedSignal(aborted = false) {
  const controller = new AbortController();
  if (aborted) controller.abort();
  const added = jest.spyOn(controller.signal, "addEventListener");
  const removed = jest.spyOn(controller.signal, "removeEventListener");
  return { controller, signal: controller.signal, added, removed };
}

describe("interruptOn", () => {
  it("interrupts the racing fiber when the controller aborts", async () => {
    const { controller, signal, added } = trackedSignal();
    const exit = await runAgent(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.never.pipe(Effect.raceFirst(interruptOn(signal))));
      yield* Effect.yieldNow;
      expect(added).toHaveBeenCalledTimes(1);
      controller.abort();
      return yield* Fiber.await(fiber);
    }));
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  });

  it("interrupts at once on an already-aborted signal", () => {
    const { signal } = trackedSignal(true);
    const exit = runAgentSync(Effect.exit(Effect.never.pipe(Effect.raceFirst(interruptOn(signal)))));
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  });

  it("detaches when the racing work completes so a later abort resumes nothing", async () => {
    const { controller, signal, added, removed } = trackedSignal();
    const value = await runAgent(Effect.gen(function* () {
      const work = yield* Deferred.make<string>();
      const fiber = yield* Effect.forkChild(Deferred.await(work).pipe(Effect.raceFirst(interruptOn(signal))));
      yield* Effect.yieldNow;
      expect(added).toHaveBeenCalledTimes(1);
      yield* Deferred.succeed(work, "done");
      return yield* Fiber.join(fiber);
    }));
    expect(value).toBe("done");
    const listener = added.mock.calls[0]?.[1];
    expect(removed).toHaveBeenCalledWith("abort", listener);
    controller.abort();
    expect(removed).toHaveBeenCalledTimes(1);
  });
});

describe("onAbort", () => {
  it("resumes with a success outcome", async () => {
    const { controller, signal } = trackedSignal();
    const value = await runAgent(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(onAbort(signal, Effect.succeed(42)));
      yield* Effect.yieldNow;
      controller.abort();
      return yield* Fiber.join(fiber);
    }));
    expect(value).toBe(42);
  });

  it("resumes with a typed failure outcome", () => {
    const { signal } = trackedSignal(true);
    const exit = runAgentSync(Effect.exit(onAbort(signal, Effect.fail(new Interrupted()))));
    expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(Interrupted);
  });
});
