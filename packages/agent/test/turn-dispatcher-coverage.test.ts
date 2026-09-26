import { runAgentSync } from "./helpers/executor";
import { catalogLayer, executorLayer } from "./helpers/service-layers";
import { describe, expect, it } from "bun:test";
import { Effect, Fiber } from "effect";
import { isolated } from "./helpers/isolated";

import {
  createDispatcher,
  createTurnDispatcher,
  currentExecutor,
  defineTool,
  type Executor,
} from "./helpers/effect-g3-dispatcher";
import { ForeignFailure } from "../src/errors";
import { currentInvocation, requireOpenInvocation, ExecutorContextError } from "../src/executor-context";
import { GenerationOwnership, SessionLayer } from "../src/services";
import { z } from "zod";
import { recordingExecutor, recordingLedger } from "./helpers/effect-g3";
import { allowAllPolicy, opPhaseOf } from "./helpers/compiled-policy";

function tool(
  name: string,
  execute: (input: object, context: { readonly signal: AbortSignal }) => Promise<string>,
  output = z.string(),
) {
  return defineTool({
    name,
    description: name,
    category: "query",
    input: z.object({}).strict(),
    output,
    visibility: { model: ["resident"], cell: ["resident"] },
    execute,
    render: (_input, value) => value,
  });
}

const passThrough = recordingExecutor().executor;

const context = { sessionId: "session-1", turnId: "turn-1" };
const call = (name: string) => ({ id: `call-${name}`, tool: name, input: {} });

describe("createTurnDispatcher", () => {
  it("exposes the captured invocation only inside its dispatched tool body", () =>
    isolated(Effect.gen(function* () {
      expect(currentInvocation).toThrow(ExecutorContextError);
      const generation = yield* GenerationOwnership;
      const { policy } = yield* SessionLayer;
      const recording = recordingLedger();
      let bodies = 0;
      const dispatcher = yield* createTurnDispatcher({
        sessionId: context.sessionId,
        role: "resident",
        actionId: context.turnId,
        ledger: recording.ledger,
      }, {}).pipe(Effect.provide(catalogLayer([
        tool("invocation", async () => {
          const frame = requireOpenInvocation();
          expect(frame).toBe(currentInvocation());
          expect(frame.executor).toBe(currentExecutor());
          expect(frame.cell.executor).toBe(frame.executor);
          expect(frame.policy).toBe(policy);
          expect(frame.generation).toBe(generation);
          bodies += 1;
          return "captured";
        }),
      ])));
      expect(yield* dispatcher.execute(call("invocation"), context)).toMatchObject({ output: "captured" });
      expect(bodies).toBe(1);
      expect(currentInvocation).toThrow(ExecutorContextError);
    })),
  );

  it("composes a durable executor and commits intent before result", async () => {
    const recording = recordingLedger();
    const dispatcher = createTurnDispatcher(
      {
        sessionId: "session-1",
        role: "resident",
        actionId: "turn-1",
        ledger: recording.ledger,
      },
      {},
    ).pipe(Effect.provide(catalogLayer([tool("echo", async () => "ok")])),
      Effect.provide(executorLayer({ policy: allowAllPolicy, observations: { publish: () => undefined }, clock: () => 1, entropy: recording.entropy })));

    const result = await isolated(Effect.flatMap(dispatcher, (value) => value.execute(call("echo"), context)));

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("ok");
    expect(recording.committed.filter((action) => action.kind === "tool").map(opPhaseOf)).toEqual([
      "echo:intent",
      "echo:result",
    ]);
  });
});

describe("wave tracking", () => {
  it("hands every model wave to trackWave as a settlement promise", async () => {
    const tracked: Promise<void>[] = [];
    const dispatcher = runAgentSync(createDispatcher({ executor: passThrough, trackWave: (wave) => tracked.push(wave) }).pipe(Effect.provide(catalogLayer([tool("ok", async () => "fine"), tool("boom", async () => Promise.reject(new Error("x")))]))));

    const results = await isolated(dispatcher.executeWave([call("ok"), call("boom")], context));
    await isolated(dispatcher.execute(call("ok"), context));
    await isolated(dispatcher.executeCell(call("ok"), context));

    expect(results.map((result) => result.isError)).toEqual([undefined, true]);
    expect(tracked).toHaveLength(0);
  });
});

describe("currentExecutor", () => {
  it("throws outside an active execution", () => {
    expect(() => currentExecutor()).toThrow(ExecutorContextError);
  });

  it("returns the executor running the tool body", async () => {
    let seen: Executor | undefined;
    const dispatcher = runAgentSync(createDispatcher({ executor: passThrough }).pipe(Effect.provide(catalogLayer([
        tool("probe", async () => {
          seen = currentExecutor();
          return "probed";
        }),
      ]))));

    await isolated(dispatcher.execute(call("probe"), context));

    expect(seen).toBe(passThrough);
  });
});

describe("tool body outcomes", () => {
  it("settles a never-resolving body as timed_out", async () => {
    const dispatcher = runAgentSync(createDispatcher({
        executor: passThrough,
        timeoutMs: 5,
      }).pipe(Effect.provide(catalogLayer([tool("stall", () => new Promise<string>(() => undefined))]))));

    const result = await isolated(dispatcher.execute(call("stall"), context));

    expect(result).toMatchObject({ isError: true, errorKind: "execution_failed" });
  });

  it("forwards the caller's abort reason into a timed body's signal", async () => {
    const caller = new AbortController();
    const bodyEntered = Promise.withResolvers<void>();
    let seenReason: Error | undefined;
    const dispatcher = runAgentSync(createDispatcher({ executor: passThrough, timeoutMs: 1000 }).pipe(Effect.provide(catalogLayer([
        tool("abortable", (_input, { signal }) => {
          bodyEntered.resolve();
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                seenReason = signal.reason;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        }),
      ]))));

    const result = await isolated(Effect.gen(function* () {
      const fiber = yield* Effect.fork(dispatcher.execute(call("abortable"), { ...context, signal: caller.signal }));
      yield* Effect.promise(() => bodyEntered.promise);
      const reason = new Error("caller aborted");
      caller.abort(reason);
      return yield* Fiber.join(fiber);
    }));
    expect(seenReason?.message).toBe("caller aborted");
    expect(result).toMatchObject({ isError: true, errorKind: "execution_failed" });
  });

  it("clears the timer when the body finishes inside the timeout", async () => {
    const dispatcher = runAgentSync(createDispatcher({
      executor: passThrough,
      timeoutMs: 1000,
    }).pipe(Effect.provide(catalogLayer([tool("fast", async () => "done")]))));

    const result = await isolated(dispatcher.execute(call("fast"), context));

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("done");
  });

  it("fails closed when the body violates the output schema", async () => {
    const dispatcher = runAgentSync(createDispatcher({ executor: passThrough }).pipe(Effect.provide(catalogLayer([
        tool(
          "bad-output",
          async () => "anything",
          z.string().refine(() => false),
        ),
      ]))));

    const result = await isolated(dispatcher.execute(call("bad-output"), context));

    expect(result).toMatchObject({ isError: true, errorKind: "invalid_output" });
  });

  it("propagates an executor failure to the caller", async () => {
    const failure = new ForeignFailure({ operation: "test", cause: "ledger unavailable" });
    const failing: Executor = {
      run() {
        return Effect.fail(failure);
      },
      runBatch() {
        return Effect.fail(failure);
      },
    };
    const dispatcher = runAgentSync(createDispatcher({ executor: failing }).pipe(Effect.provide(catalogLayer([tool("echo", async () => "ok")]))));

    const result = await isolated(Effect.either(dispatcher.execute(call("echo"), context)));
    expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ForeignFailure", operation: "test" } });
  });
});
