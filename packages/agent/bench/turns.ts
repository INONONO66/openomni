import type { ResolvedExecutorOptions } from "../src/executor-contract";
import { runAgentSync } from "../test/helpers/executor";
import { turnTestLayer } from "../test/helpers/service-layers";
import { prepareChatFixture } from "../test/helpers/chat-services";
import { type SessionFixture as SessionRuntime, type SessionFixture, withSessionServices } from "../test/helpers/session-services";
import { catalogLayer } from "../test/helpers/service-layers";
import { Effect, Exit, Scope } from "effect";
import { Storage } from "@openomni/ledger";
import { accumulateUsage } from "@openomni/llm";
import type { ObservationSink, Token } from "@openomni/protocol";
import type { Bench } from "tinybench";
import { closeSessions, session } from "../src/session-handle";
import { createSessionChatRunner } from "../src/session-chat-runner";
import { createDispatcher, createTurnDispatcher } from "../src/tool-dispatcher";
import { recordingExecutor } from "../test/helpers/effect-g2";
import { assistantWithParts } from "../test/helpers/messages";
import { completeModel, mockLlm, mockProviderModel } from "../test/helpers/mock-llm";
import { valueTool } from "../test/helpers/query-tool";
import { runInput } from "../test/helpers/run-input";
import { seedPolicy } from "../test/helpers/seed-policy";
import { createTestAgent } from "../test/helpers/effect-g2";

const events: ObservationSink = { publish: () => undefined };
const model = { provider: "anthropic", id: mockProviderModel.id };

export function runBenchEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

export async function firstDelta(now: () => number) {
  const first = Promise.withResolvers<number>();
  const agent = createTestAgent({ events, model, llm: mockLlm(completeModel) });
  const input = runInput([{ role: "user", content: "hello" }]);
  const sink = {
    onMessage: () => first.resolve(now() - start),
    onToolCall: () => undefined,
    onToolResult: () => undefined,
  };
  const start = now();
  // Drain persistence before another sample starts, but time only the first snapshot.
  await runBenchEffect(agent.run(input, sink));
  return { overriddenDuration: await first.promise };
}

export function toolDispatch() {
  const recording = recordingExecutor();
  const dispatcher = runAgentSync(createDispatcher({ executor: recording.executor }).pipe(Effect.provide(catalogLayer([valueTool({ name: "echo", execute: async (value) => value })]))));
  return {
    committed: recording.committed,
    run: () => runBenchEffect(dispatcher.execute(
      { id: "call-1", tool: "echo", input: { value: "hello" } },
      { sessionId: "session-1", turnId: "turn-1" },
    )),
  };
}

export async function roundTrip() {
  Storage.initialize({ dbPath: ":memory:", observationSink: events });
  seedPolicy();
  const runtime: SessionRuntime = { observations: events };
  const runner = createSessionChatRunner({
    prepare: (input) => Effect.gen(function* () { return prepareChatFixture(({
      config: {
        events,
        model,
        llm: mockLlm(completeModel),
        executor: (yield* Effect.gen(function* () { const turnInput: Parameters<typeof createTurnDispatcher>[0] & { readonly policy?: ResolvedExecutorOptions["policy"] } = input; const turnRuntime: Parameters<typeof createTurnDispatcher>[1] & Partial<Pick<ResolvedExecutorOptions, "clock" | "entropy" | "observations">> = runtime; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer([])), Effect.provide(turnTestLayer(turnInput, turnRuntime))); })).executor,
      },
      traceContext: {
        traceId: "trace-agent-bench",
        sessionId: input.sessionId,
        runId: input.turnId,
      },
    })); }),
  });
  const scope = await runBenchEffect(Scope.make());
  const close = () => runBenchEffect(closeSessions(runtime).pipe(
    Effect.ensuring(Scope.close(scope, Exit.void)),
    Effect.ensuring(Effect.sync(() => Storage.reset())),
  ));
  try {
    const handle = await runBenchEffect(
      Effect.gen(function* () { const fixture: SessionFixture = runtime; return yield* withSessionServices(session({ id: "bench-turn", role: "resident", runner }, fixture), fixture); }).pipe(Scope.extend(scope)),
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
    beforeEach: () => { dispatch = toolDispatch(); },
  });

  let turn: Awaited<ReturnType<typeof roundTrip>>;
  bench.add("turn/round-trip", () => turn.run(), {
    async: true,
    beforeEach: async () => { turn = await roundTrip(); },
    afterEach: () => turn.close(),
  });

  bench.add("turn/token-accounting", tokenAccounting, { async: false });
}
