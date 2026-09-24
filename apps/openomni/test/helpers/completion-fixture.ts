import { Bus, ObservationSink } from "@openomni/agent";
import { Llm, Provider, run } from "@openomni/llm";
import { Effect } from "effect";
import { createCompletionPort } from "../../src/composition/completion";
import type { FixtureLlm } from "./app-fixture";

export function completionFixture(model: Parameters<typeof createCompletionPort>[0], service: Partial<FixtureLlm> = {}) {
  const port = createCompletionPort(model);
  return (call: Parameters<typeof port>[0]) => port(call).pipe(
    Effect.provideService(Llm, { run, resolveModel: Provider.resolveModel, ...service }),
    Effect.provideService(ObservationSink, Bus),
  );
}
