import { Kernel, Model } from "@openomni/agent";
const ObservationSink = Kernel.ObservationSink;
import { Bus } from "./bus";
const Llm = Model.Llm;
const run = Model.run;
import { Effect } from "effect";
import { createCompletionPort } from "../../src/composition/completion";
import type { FixtureLlm } from "./app-fixture";
import { testIds } from "./test-entropy";

export function completionFixture(model: Parameters<typeof createCompletionPort>[0], service: Partial<FixtureLlm> = {}) {
  const port = createCompletionPort(model, { now: () => 1000, id: testIds("completion") });
  return (call: Parameters<typeof port>[0]) => port(call).pipe(
    Effect.provideService(Llm, { run, resolveModel: Model.Provider.resolveModel, ...service }),
    Effect.provideService(ObservationSink, Bus),
  );
}
