import { expect, it } from "bun:test";
import { runWaveBodies } from "../../../src/core/execution/tool-wave";
import { recordingExecutor } from "../../helpers/compiled-policy";
import { createDispatcher, defineTool } from "../../../src/tool-dispatcher";
import { z } from "zod";

for (const door of ["cell", "wave"] as const) {
  for (const rejects of [false, true]) {
    it(`inherits retention into a timed ${door} definition that ${rejects ? "rejects" : "fulfills"}`, async () => {
      // Given: a real unbound executor inherits only the surrounding wave's owner.
      const gate = Promise.withResolvers<void>();
      const timedOut = Promise.withResolvers<void>();
      const effects = new Set<Promise<void>>();
      const executor = recordingExecutor().executor;
      const dispatcher = createDispatcher([defineTool({
        name: "timed", description: "timed effect", category: "query",
        visibility: { model: ["resident"], cell: ["resident"] },
        input: z.object({}), output: z.string(), render: (_input, output) => output,
        async execute(_input, context) {
          context.signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
          await gate.promise;
          if (rejects) throw new Error("raw effect rejected");
          return "effect";
        },
      })], { executor, timeoutMs: 0 });
      const wave = runWaveBodies([{
        async run() {
          const call = { id: "timed-call", tool: "timed", input: {} };
          const context = { sessionId: "session-1", turnId: "turn-1" };
          const results = door === "cell"
            ? [await dispatcher.executeCell(call, context)]
            : await dispatcher.executeWave([call], context);
          expect(results.map((result) => result.isError)).toEqual([true]);
          return null;
        },
      }], {
        signal: new AbortController().signal,
        retain(effect) {
          effects.add(effect);
          void effect.then(() => effects.delete(effect));
        },
      });
      try {
        // When: actual timeout and both caller wrappers settle before the definition.
        await timedOut.promise;
        await wave;
        // Then: exactly the raw definition settlement still belongs to the owner.
        expect(effects.size).toBe(1);
        gate.resolve();
        await Promise.all(effects);
        expect(effects.size).toBe(0);
      } finally {
        gate.resolve();
        await wave;
        await Promise.all(effects);
      }
    }, 5000);
  }
}

it("inherits raw-body retention through nested executors without a bound turn owner", async () => {
  // Given: ownership supplied only at the enclosing wave, not on either executor.
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<null>();
  const parentSettled = Promise.withResolvers<void>();
  const effects = new Set<Promise<void>>();
  const outer = recordingExecutor().executor;
  const inner = recordingExecutor().executor;
  const request = { kind: "tool", op: "nested", intent: {}, effect: {} };
  const wave = runWaveBodies([{
    async run() {
      try {
        await outer.run(request, async () => {
          if (inner.runBatch === undefined) throw new Error("missing batch executor");
          await inner.runBatch([{ request, body: () => {
            entered.resolve();
            return gate.promise;
          } }], { signal: new AbortController().signal });
          return null;
        });
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
      } finally {
        parentSettled.resolve();
      }
      return null;
    },
  }], { signal: controller.signal, retain(effect) { effects.add(effect); } });
  try {
    await entered.promise;
    // When: the wave cancels and both executor wrappers unwind before the raw body.
    controller.abort();
    expect(await wave).toEqual([{ status: "cancelled" }]);
    await parentSettled.promise;
    // Then: all three actual bodies, not just the outer raced wrapper, were retained.
    expect(effects.size).toBe(3);
  } finally {
    gate.resolve(null);
    await wave;
    await Promise.all(effects);
  }
}, 5000);

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
