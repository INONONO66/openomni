import { expect, it } from "bun:test";
import { runWaveBodies, waveBodyScope } from "../../../src/core/execution/tool-wave";
import { allowAllPolicy, recordingExecutor, recordingLedger } from "../../helpers/compiled-policy";
import { createExecutor } from "../../../src/executor";
import { createDispatcher, defineTool } from "../../../src/tool-dispatcher";
import { z } from "zod";

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("retention signal deadline")), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}

for (const door of ["cell", "wave"] as const) {
  for (const reason of ["Error", "plain-value"] as const) {
    for (const owner of ["bound", "inherited"] as const) {
      it(`fulfills ${owner} ownership after timed ${door} ${reason} rejection`, async () => {
        // Given: production executor/dispatcher, with the session owner's deletion contract.
        const gate = Promise.withResolvers<void>();
        const timedOut = Promise.withResolvers<void>();
        const effects = new Set<Promise<void>>();
        const observers: Promise<void>[] = [];
        const rejectedOwnership: string[] = [];
        let foreignRetentions = 0;
        let rawSettled = false;
        const retain = (effect: Promise<void>) => {
          effects.add(effect);
          observers.push(effect.then(
            () => { effects.delete(effect); },
            // Diagnose rejection without deleting it or leaking an unhandled descendant.
            (error: unknown) => {
              rejectedOwnership.push(error instanceof Error ? error.name : typeof error);
            },
          ));
        };
        const recording = recordingLedger();
        const executor = createExecutor({
          policy: allowAllPolicy, ledger: recording.ledger, observations: { publish: () => undefined },
          identity: { sessionId: "session-1", role: "resident", parentActionId: null },
          clock: () => 1, entropy: recording.entropy,
          ...(owner === "bound" ? { retainEffect: retain } : {}),
        });
        const dispatcher = createDispatcher([defineTool({
          name: "timed", description: "actual timed rejection", category: "query",
          visibility: { model: ["resident"], cell: ["resident"] },
          input: z.object({}), output: z.string(), render: (_input, output) => output,
          async execute(_input, context) {
            context.signal.addEventListener("abort", () => timedOut.resolve(), { once: true });
            await gate.promise;
            rawSettled = true;
            if (reason === "Error") throw new Error("raw definition rejected");
            // Legal JSON rejection whose String conversion throws.
            return Promise.reject({ toString: 0 });
          },
        })], { executor, timeoutMs: 0, retainEffect() { foreignRetentions += 1; } });
        const wrapper = waveBodyScope.run({
          signal: new AbortController().signal,
          retain: owner === "inherited" ? retain : () => { foreignRetentions += 1; },
        }, async () => {
          const call = { id: "timed-call", tool: "timed", input: {} };
          const context = { sessionId: "session-1", turnId: "turn-1" };
          return door === "cell"
            ? [await dispatcher.executeCell(call, context)]
            : await dispatcher.executeWave([call], context);
        });
        try {
          // When: the exact timeout and caller detach while the actual definition is gated.
          await bounded(timedOut.promise);
          const results = await bounded(wrapper);
          const frozen = structuredClone(results);
          expect(results).toMatchObject([{ isError: true, errorKind: "execution_failed" }]);
          expect(recording.committed.at(-1)?.effect?.value).toMatchObject({
            terminal: "executed", result: { status: "timed_out" },
          });
          expect(rawSettled).toBe(false);
          expect(foreignRetentions).toBe(0);
          expect(effects.size).toBe(1);
          const actionCount = recording.committed.length;
          const pending = [...effects];
          gate.resolve();
          const settlement = await bounded(Promise.allSettled(pending));
          await bounded(Promise.all(observers));
          // Then: even a conversion failure cannot reject ownership or change frozen results.
          expect(rawSettled).toBe(true);
          expect(results).toEqual(frozen);
          expect(recording.committed).toHaveLength(actionCount);
          expect(settlement.map((result) => result.status)).toEqual(["fulfilled"]);
          expect(rejectedOwnership).toEqual([]);
          expect(effects.size).toBe(0);
        } finally {
          gate.resolve();
          await bounded(wrapper);
          await bounded(Promise.allSettled([...effects]));
          await bounded(Promise.all(observers));
        }
      }, 15000);
    }

    it(`reports timed ${door} ${reason} rejection before timeout`, async () => {
      // Given: a real definition rejects in a microtask, before the timeout timer can fire.
      const recording = recordingExecutor();
      const dispatcher = createDispatcher([defineTool({
        name: "timed", description: "immediate rejection", category: "query",
        visibility: { model: ["resident"], cell: ["resident"] },
        input: z.object({}), output: z.string(), render: (_input, output) => output,
        async execute() {
          if (reason === "Error") throw new Error("raw definition rejected");
          return Promise.reject({ toString: 0 });
        },
      })], { executor: recording.executor, timeoutMs: 0 });
      const call = { id: "timed-call", tool: "timed", input: {} };
      const context = { sessionId: "session-1", turnId: "turn-1" };
      // When: the result path, rather than timeout, wins.
      // Then: cell propagates conversion failure; other results report execution failure.
      if (door === "cell" && reason === "plain-value") {
        await expect(dispatcher.executeCell(call, context)).rejects.toBeInstanceOf(TypeError);
      } else {
        const results = door === "cell"
          ? [await dispatcher.executeCell(call, context)]
          : await dispatcher.executeWave([call], context);
        expect(results).toMatchObject([{ isError: true, errorKind: "execution_failed" }]);
      }
      expect(recording.committed.at(-1)?.effect?.value).toMatchObject(
        reason === "Error"
          ? { terminal: "executed", result: { status: "error", errorKind: "execution_failed" } }
          : { terminal: "failed" },
      );
    });
  }
}

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
