import { runAgentSync } from "../test/helpers/executor";
import { chatServices } from "../test/helpers/chat-services";
import { type SessionFixture, withSessionServices } from "../test/helpers/session-services";
import { catalogLayer, executorLayer } from "../test/helpers/service-layers";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  compilePolicySnapshot,
  KERNEL_POLICY_REGISTRY,
  SEEDED_POLICY_ROWS,
} from "@openomni/policy";
import { Storage } from "@openomni/ledger";
import { accumulateUsage, Llm } from "@openomni/llm";
import type { Token } from "@openomni/protocol";
import { Entropy, ObservationSink } from "../src/services";
import { allowAllPolicy } from "../test/helpers/compiled-policy";
import type { Bench } from "tinybench";
import { closeSessions, session } from "../src/session-handle";
import { createSessionChatRunner } from "../src/session-chat-runner";
import { createDispatcher, createTurnDispatcher } from "../src/tool-dispatcher";
import { nullRetryAlarm, recordingLedger } from "../test/helpers/effect-g2";
import { createExecutor } from "../src/executor";
import { runAgent } from "../src/core/execution/run";
import { assistantWithParts } from "../test/helpers/messages";
import { completeModel, mockLlm, mockProviderModel } from "../test/helpers/mock-llm";
import { valueTool } from "../test/helpers/query-tool";
import { runInput } from "../test/helpers/run-input";
import { seedPolicy } from "../test/helpers/seed-policy";

// Keep the reference benchmark's no-op observation port; fixture helpers otherwise
// add a bus and event stamping to every dispatch, changing what this metric measures.
const events: Context.Tag.Service<typeof ObservationSink> = {
  publish: () => undefined,
  subscribe: () => () => undefined,
  scope: () => events,
};
const model = { provider: "anthropic", id: mockProviderModel.id };
const chatLayer = chatServices({ events, model, llm: mockLlm(completeModel) });
// Production pins policy and acquires service Layers for a generation, not a model call.
const policy = compilePolicySnapshot({
  registry: KERNEL_POLICY_REGISTRY,
  generation: 1,
  rows: SEEDED_POLICY_ROWS.map((row) => ({ ...row, generation: 1 })),
});
// These Layers contain only pure values, so their contexts outlive acquisition.
const firstDeltaServices = runAgentSync(
  Effect.scoped(
    Layer.build(
      Layer.merge(
        chatLayer,
        executorLayer({
          policy,
          observations: events,
          clock: Date.now,
          entropy: () => crypto.randomUUID(),
        }),
      ),
    ),
  ),
);
const dispatchServices = runAgentSync(
  Effect.scoped(
    Layer.build(
      Layer.merge(
        executorLayer({
          policy: allowAllPolicy,
          observations: events,
          clock: () => 1,
          entropy: () => crypto.randomUUID(),
        }),
        catalogLayer([valueTool({ name: "echo", execute: async (value) => value })]),
      ),
    ),
  ),
).pipe(Context.add(ObservationSink, events));

export function runBenchEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

export async function firstDelta(now: () => number) {
  const first = Promise.withResolvers<number>();
  const record = recordingLedger();
  const services = firstDeltaServices.pipe(Context.add(Entropy, { next: record.entropy }));
  const input = runInput([{ role: "user", content: "hello" }]);
  const sink = {
    onMessage: () => first.resolve(now() - start),
    onToolCall: () => undefined,
    onToolResult: () => undefined,
  };
  const start = now();
  // Keep per-turn acquisition and record-before-act inside the measured interval.
  // Drain persistence before another sample starts, but time only the first snapshot.
  await runBenchEffect(
    Effect.gen(function* () {
      const executor = yield* createExecutor({
        ledger: record.ledger,
        retryAlarm: nullRetryAlarm,
        identity: {
          sessionId: input.traceContext.sessionId,
          role: "resident",
          parentActionId: null,
        },
      });
      return yield* runAgent(input, { model, executor, execution: executor }, sink);
    }).pipe(Effect.provide(services)),
  );
  return { overriddenDuration: await first.promise };
}

export function toolDispatch() {
  const record = recordingLedger();
  const dispatcher = runAgentSync(
    Effect.gen(function* () {
      const executor = yield* createExecutor({
        ledger: record.ledger,
        retryAlarm: nullRetryAlarm,
        identity: { sessionId: "session-1", role: "resident", parentActionId: null },
      });
      return yield* createDispatcher({ executor });
    }).pipe(Effect.provide(dispatchServices.pipe(Context.add(Entropy, { next: record.entropy })))),
  );
  return {
    committed: record.committed,
    run: () =>
      runBenchEffect(
        dispatcher.execute(
          { id: "call-1", tool: "echo", input: { value: "hello" } },
          { sessionId: "session-1", turnId: "turn-1" },
        ),
      ),
  };
}

export async function roundTrip() {
  Storage.initialize({ dbPath: ":memory:", observationSink: events });
  seedPolicy();
  const runtime: SessionFixture = { observations: events };
  const scope = await runBenchEffect(Scope.make());
  const services = Context.pick(Llm)(await runBenchEffect(Layer.buildWithScope(chatLayer, scope)));
  const runner = createSessionChatRunner({
    prepare: (input) =>
      Effect.gen(function* () {
        // Like the resident, acquire a fresh dispatcher from the captured generation
        // on every turn; do not rebuild or override the generation's service Layers.
        const dispatcher = yield* createTurnDispatcher(input, runtime);
        return {
          config: { model, executor: dispatcher.executor },
          traceContext: {
            traceId: "trace-agent-bench",
            sessionId: input.sessionId,
            runId: input.turnId,
          },
        };
      }),
  });
  const close = () =>
    runBenchEffect(
      closeSessions(runtime).pipe(
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.ensuring(Effect.sync(() => Storage.reset())),
      ),
    );
  try {
    const handle = await runBenchEffect(
      withSessionServices(
        session(
          {
            id: "bench-turn",
            role: "resident",
            runner: (input) => runner(input).pipe(Effect.provide(services)),
          },
          runtime,
        ),
        runtime,
      ).pipe(Scope.extend(scope)),
    );
    return { handle, run: () => runBenchEffect(handle.prompt("hello")), close };
  } catch (error) {
    await close();
    throw error;
  }
}

const message = assistantWithParts("usage", "bench-turn", [], 512, 128);
const usage: Token.ProviderUsage = {
  inputTokens: message.info.tokens.input,
  outputTokens: message.info.tokens.output,
  reasoningTokens: 32,
  cacheReadTokens: 64,
  cacheWriteTokens: 16,
};

export function tokenAccounting(): Token.AgentUsage {
  const total: Token.AgentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  accumulateUsage(total, usage);
  return total;
}

export function addTurnBenchmarks(bench: Bench): void {
  bench.add("turn/first-delta", () => firstDelta(bench.now), { async: true });

  let dispatch: ReturnType<typeof toolDispatch>;
  bench.add("turn/tool-dispatch", () => dispatch.run(), {
    async: true,
    beforeEach: () => {
      dispatch = toolDispatch();
    },
  });

  let turn: Awaited<ReturnType<typeof roundTrip>>;
  bench.add("turn/round-trip", () => turn.run(), {
    async: true,
    beforeEach: async () => {
      turn = await roundTrip();
    },
    afterEach: () => turn.close(),
  });

  bench.add("turn/token-accounting", tokenAccounting, { async: false });
}
