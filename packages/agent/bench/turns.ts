import { Storage } from "@openomni/ledger";
import { accumulateUsage } from "@openomni/llm";
import type { ObservationSink, Token } from "@openomni/protocol";
import type { Bench } from "tinybench";
import { closeSessions, session, type SessionRuntime } from "../src/session-handle";
import { createSessionChatRunner } from "../src/session-chat-runner";
import { createDispatcher, createTurnDispatcher } from "../src/tool-dispatcher";
import { recordingExecutor } from "../test/helpers/compiled-policy";
import { assistantWithParts } from "../test/helpers/messages";
import { completeModel, mockLlm, mockProviderModel } from "../test/helpers/mock-llm";
import { valueTool } from "../test/helpers/query-tool";
import { runInput } from "../test/helpers/run-input";
import { seedPolicy } from "../test/helpers/seed-policy";
import { createTestAgent } from "../test/helpers/test-agent";

const events: ObservationSink = { publish: () => undefined };
const model = { provider: "anthropic", id: mockProviderModel.id };

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
  await agent.run(input, sink);
  return { overriddenDuration: await first.promise };
}

export function toolDispatch() {
  const recording = recordingExecutor();
  const dispatcher = createDispatcher(
    [valueTool({ name: "echo", execute: async (value) => value })],
    { executor: recording.executor },
  );
  return {
    committed: recording.committed,
    run: () => dispatcher.execute(
      { id: "call-1", tool: "echo", input: { value: "hello" } },
      { sessionId: "session-1", turnId: "turn-1" },
    ),
  };
}

export function roundTrip() {
  Storage.initialize({ dbPath: ":memory:", observationSink: events });
  seedPolicy();
  const runtime: SessionRuntime = { observations: events };
  const runner = createSessionChatRunner({
    prepare: (input) => ({
      config: {
        events,
        model,
        llm: mockLlm(completeModel),
        executor: createTurnDispatcher([], input, runtime).executor,
      },
      traceContext: {
        traceId: "trace-agent-bench",
        sessionId: input.sessionId,
        runId: input.turnId,
      },
    }),
  });
  const handle = session({ id: "bench-turn", role: "resident", runner }, runtime);
  return {
    handle,
    run: () => handle.prompt("hello"),
    async close() {
      try {
        await closeSessions(runtime);
      } finally {
        Storage.reset();
      }
    },
  };
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

  let turn: ReturnType<typeof roundTrip>;
  bench.add("turn/round-trip", () => turn.run(), {
    async: true,
    beforeEach: () => { turn = roundTrip(); },
    afterEach: () => turn.close(),
  });

  bench.add("turn/token-accounting", tokenAccounting, { async: false });
}
