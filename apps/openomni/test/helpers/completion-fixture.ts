import { ObservationSink } from "@openomni/agent";
import { Bus } from "./bus";
import { Llm, Provider, run } from "@openomni/agent";
import { Effect } from "effect";
import { createCompletionPort } from "../../src/composition/completion";
import type { FixtureLlm } from "./app-fixture";
import { testIds } from "./test-entropy";

export function completionFixture(model: Parameters<typeof createCompletionPort>[0], service: Partial<FixtureLlm> = {}) {
  const port = createCompletionPort(model, { now: () => 1000, id: testIds("completion") });
  return (call: Parameters<typeof port>[0]) => port(call).pipe(
    Effect.provideService(Llm, { run, resolveModel: Provider.resolveModel, ...service }),
    Effect.provideService(ObservationSink, Bus),
  );
}
