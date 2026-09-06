import { expect, it } from "bun:test";
import { runWaveBodies } from "../../../src/core/execution/tool-wave";

it("freezes unsettled slots as canceled at the abort event, even if a body resolves in that event", async () => {
  // Given: the actual scheduler and a body that returns late success from its abort callback.
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<{ late: boolean }>();
  const pending = runWaveBodies(
    [
      {
        run() {
          controller.signal.addEventListener("abort", () => result.resolve({ late: true }), {
            once: true,
          });
          entered.resolve();
          return result.promise;
        },
      },
    ],
    { signal: controller.signal },
  );
  await entered.promise;
  // When: cancellation and the cooperative body's late completion share one event.
  controller.abort();
  // Then: event ordering cannot fabricate a successfully settled slot after cancellation.
  expect(await pending).toEqual([{ status: "cancelled" }]);
});

it("does not enter a body when cancellation predates the wave", async () => {
  const controller = new AbortController();
  controller.abort();
  let entered = 0;
  const result = await runWaveBodies(
    [
      {
        async run() {
          entered += 1;
          return null;
        },
      },
    ],
    { signal: controller.signal },
  );
  expect(result).toEqual([{ status: "cancelled" }]);
  expect(entered).toBe(0);
});

it("joins preceding work and blocks following work at a sequential barrier", async () => {
  const first = Promise.withResolvers<null>();
  const barrier = Promise.withResolvers<null>();
  const firstEntered = Promise.withResolvers<void>();
  const barrierEntered = Promise.withResolvers<void>();
  const entered: string[] = [];
  const wave = runWaveBodies(
    [
      {
        run() {
          entered.push("A");
          firstEntered.resolve();
          return first.promise;
        },
      },
      {
        sequential: true,
        run() {
          entered.push("D");
          barrierEntered.resolve();
          return barrier.promise;
        },
      },
      {
        async run() {
          entered.push("E");
          return null;
        },
      },
    ],
    { signal: new AbortController().signal },
  );
  try {
    await firstEntered.promise;
    expect(entered).toEqual(["A"]);
    first.resolve(null);
    await barrierEntered.promise;
    expect(entered).toEqual(["A", "D"]);
    barrier.resolve(null);
    await wave;
    expect(entered).toEqual(["A", "D", "E"]);
  } finally {
    first.resolve(null);
    barrier.resolve(null);
    await wave;
  }
});
