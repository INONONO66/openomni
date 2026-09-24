import { turnTestLayer, catalogLayer } from "./service-layers";
import { prepareChatFixture } from "./chat-services";
import type { SessionFixture as SessionRuntime } from "./session-services";
import { Effect } from "effect";
import type { RunInput, Sink } from "@openomni/llm";
import type { SessionRunnerInput, SessionRunner } from "../../src/session-handle";
import { createSessionChatRunner } from "../../src/session-chat-runner";
import { createTurnDispatcher } from "../../src/tool-dispatcher";
import type { ExecutionError } from "../../src/errors";
import { completeModel } from "./mock-llm";

/** A real session chat runner with an Effect-native model-entry barrier. */
export function countingRunner(
  runtime: SessionRuntime,
  calls: { model: number },
  onModel: () => Effect.Effect<void, ExecutionError> = () => Effect.void,
): SessionRunner {
  return createSessionChatRunner({
    prepare: (input: SessionRunnerInput) => Effect.gen(function* () {
      const dispatcher = (yield* Effect.gen(function* () { const turnInput = input; const turnRuntime = runtime; return yield* createTurnDispatcher(turnInput, turnRuntime).pipe(Effect.provide(catalogLayer([])), Effect.provide(turnTestLayer(turnInput, turnRuntime))); }));
      return prepareChatFixture({
        traceContext: { traceId: "trace", sessionId: input.sessionId, runId: input.resultId },
        config: {
          events: { publish: () => undefined },
          executor: dispatcher.executor,
          model: { provider: "test", id: "test" },
          llm: {
            resolveModel: () => Effect.succeed({ providerID: "test", id: "test", name: "test" }),
            run: (request: RunInput, sink: Sink) => Effect.gen(function* () {
              // A failed test barrier is a defect, not a retryable provider failure.
              yield* onModel().pipe(Effect.orDie);
              calls.model += 1;
              return yield* Effect.promise(() => completeModel(request, sink));
            }),
          },
        },
      }); }),
  });
}
