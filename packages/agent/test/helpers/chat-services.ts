import { Llm, LlmLive } from "../../src/model";
import { type Context, Effect, Layer } from "effect";
import type { ChatAgentConfig, ObservedChatAgentConfig } from "../../src/core/types";
import type { createSessionChatRunner } from "../../src/core/run";
import { ObservationSink } from "../../src/core/ports";
import { fixtureCompactionSeam } from "./fixture-compaction";
import { observationService } from "./service-layers";

export { fixtureCompactionSeam } from "./fixture-compaction";

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
  const { events: _events, llm: _llm, ...rest } = prepared.config;
  const config = "compactionSeam" in rest ? rest : { ...rest, compactionSeam: fixtureCompactionSeam };
  return {
    ...prepared,
    config: config satisfies ChatAgentConfig & Pick<Prepared["config"], "executor">,
    around: (work) =>
      (prepared.around?.(work) ?? work).pipe(Effect.provide(chatServices(prepared.config))),
  };
}
