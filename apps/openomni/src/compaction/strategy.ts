import type { CompactionOptions, ObservationSink } from "@openomni/agent";
import type { Llm } from "@openomni/llm";
import { Effect } from "effect";
import type { OpenOmniConfig } from "../config";
import { modelTransport } from "../config";
import { createCompactionSummarizer } from "./summarizer";

/** Translate operator configuration into the callback-free run-scoped strategy. */
export function configuredCompaction(config: OpenOmniConfig): Effect.Effect<CompactionOptions, never, Llm | ObservationSink> {
  return Effect.gen(function* () {
  const transport = modelTransport(config.model);
  return {
    elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 500 },
    ...(config.compactionSummarizer === false
      ? {}
      : {
          onSummarize: yield* createCompactionSummarizer({
            model: { ...config.model, ...(transport === undefined ? {} : { transport }) },
          }),
        }),
  };
  });
}
