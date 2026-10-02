import { Llm, LlmLive } from "../../src/model";
import { type Context, Effect, Layer } from "effect";
import type { ChatAgentConfig, ObservedChatAgentConfig } from "../../src/core/types";
import type { createSessionChatRunner } from "../../src/session-chat-runner";
import { ObservationSink } from "../../src/services";
import { observationService } from "./service-layers";

export interface ChatFixture extends ObservedChatAgentConfig {
  readonly llm?: Partial<Context.Service.Shape<typeof Llm>>;
}

export function chatServices(fixture: ChatFixture) {
  return Layer.mergeAll(
    Layer.succeed(ObservationSink, observationService(fixture.events)),
    Layer.effect(
      Llm,
      Effect.map(Llm, (service) => ({ ...service, ...fixture.llm })),
    ).pipe(Layer.provide(LlmLive)),
  );
}

type Prepared = Effect.Success<
  ReturnType<Parameters<typeof createSessionChatRunner>[0]["prepare"]>
>;

/** Shared trace identity of a turn-dispatcher chat fixture. */
export function fixtureTraceContext(input: {
  readonly sessionId: string;
  readonly resultId: string;
}) {
  return { traceId: "trace", sessionId: input.sessionId, runId: input.resultId };
}

/** Shared config head of a turn-dispatcher chat fixture: silent events, test model. */
export function fixtureConfigHead(executor: Prepared["config"]["executor"]) {
  return {
    events: { publish: () => undefined },
    executor,
    model: { provider: "test", id: "test" },
  };
}

export function prepareChatFixture(
  prepared: Omit<Prepared, "config"> & {
    readonly config: ChatFixture & Pick<Prepared["config"], "executor">;
  },
): Prepared {
  const { events: _events, llm: _llm, ...config } = prepared.config;
  return {
    ...prepared,
    config: config satisfies ChatAgentConfig & Pick<Prepared["config"], "executor">,
    around: (work) =>
      (prepared.around?.(work) ?? work).pipe(Effect.provide(chatServices(prepared.config))),
  };
}
