import { Llm, LlmLive } from "@openomni/llm";
import { type Context, Effect, Layer } from "effect";
import type { ChatAgentConfig, ObservedChatAgentConfig } from "../../src/core/types";
import type { createSessionChatRunner } from "../../src/session-chat-runner";
import { ObservationSink } from "../../src/services";
import { observationService } from "./service-layers";

export interface ChatFixture extends ObservedChatAgentConfig {
  readonly llm?: Partial<Context.Tag.Service<typeof Llm>>;
}

export function chatServices(fixture: ChatFixture) {
  return Layer.mergeAll(
    Layer.succeed(ObservationSink, observationService(fixture.events)),
    Layer.effect(Llm, Effect.map(Llm, (service) => ({ ...service, ...fixture.llm }))).pipe(Layer.provide(LlmLive)),
  );
}

type Prepared = Effect.Effect.Success<ReturnType<Parameters<typeof createSessionChatRunner>[0]["prepare"]>>;
export function prepareChatFixture(prepared: Omit<Prepared, "config"> & { readonly config: ChatFixture & Pick<Prepared["config"], "executor"> }): Prepared {
  const { events: _events, llm: _llm, ...config } = prepared.config;
  return { ...prepared, config: config satisfies ChatAgentConfig & Pick<Prepared["config"], "executor">,
    around: (work) => (prepared.around?.(work) ?? work).pipe(Effect.provide(chatServices(prepared.config))),
  };
}
