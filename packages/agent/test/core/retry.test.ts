import { describe, expect, it, spyOn } from "bun:test";
import { Cause, Effect, Exit, Fiber, TestClock, TestContext } from "effect";
import { Retry } from "@openomni/llm";
import { abortError, isAbort } from "../../src/core/retry";
import { isolated } from "../helpers/isolated";
import { boundedSignal } from "../helpers/g0-signals";

describe("Retry.sleep", () => {
  it("interrupts immediately when the signal is already aborted", () =>
    isolated(
      Effect.gen(function* () {
        const controller = new AbortController();
        controller.abort();
        const timeout = spyOn(globalThis, "setTimeout");
        try {
          const exit = yield* Effect.exit(Retry.sleep(5_000, controller.signal));
          expect(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)).toBe(true);
          expect(timeout).not.toHaveBeenCalled();
        } finally {
          timeout.mockRestore();
        }
      }),
    ));

  it("interrupts when the signal aborts during sleep", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const controller = new AbortController();
          const registered = Promise.withResolvers<void>();
          const add = controller.signal.addEventListener.bind(controller.signal);
          const listener = spyOn(controller.signal, "addEventListener").mockImplementation(
            (...args: Parameters<AbortSignal["addEventListener"]>) => {
              add(...args);
              registered.resolve();
            },
          );
          try {
            const sleeping = yield* Effect.fork(Retry.sleep(5_000, controller.signal));
            yield* boundedSignal(registered.promise, "abort listener registered");
            controller.abort();
            const exit = yield* Fiber.await(sleeping);
            expect(Exit.isFailure(exit) && Cause.isInterrupted(exit.cause)).toBe(true);
          } finally {
            listener.mockRestore();
          }
        }),
      ),
    ));

  it("removes the abort listener after normal completion", () =>
    isolated(
      Effect.scoped(
        Effect.gen(function* () {
          const controller = new AbortController();
          const registered = Promise.withResolvers<void>();
          const add = controller.signal.addEventListener.bind(controller.signal);
          const added = spyOn(controller.signal, "addEventListener").mockImplementation(
            (...args: Parameters<AbortSignal["addEventListener"]>) => {
              add(...args);
              registered.resolve();
            },
          );
          const removed = spyOn(controller.signal, "removeEventListener");
          try {
            const sleeping = yield* Effect.fork(Retry.sleep(1, controller.signal));
            yield* boundedSignal(registered.promise, "abort listener registered");
            expect(added).toHaveBeenCalledTimes(1);
            yield* TestClock.adjust(1);
            yield* Fiber.join(sleeping);
            expect(removed).toHaveBeenCalledTimes(1);
          } finally {
            added.mockRestore();
            removed.mockRestore();
          }
        }),
      ).pipe(Effect.provide(TestContext.TestContext)),
    ));
});

describe("isAbort (audit M4)", () => {
  it("recognizes an aborted signal regardless of the error message", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbort(new Error("connection timeout"), controller.signal)).toBe(true);
  });
  it("recognizes the typed abort error without a signal", () => {
    expect(isAbort(abortError(), undefined)).toBe(true);
    expect(abortError().name).toBe("AbortError");
  });
  it("does NOT classify by message substring: a tool error mentioning 'aborted' is not an abort", () => {
    const controller = new AbortController();
    expect(isAbort(new Error("tool run aborted by remote host"), controller.signal)).toBe(false);
  });
});
