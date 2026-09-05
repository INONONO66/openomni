import type { CompactionOptions } from "@openomni/agent";
import type { OpenOmniConfig } from "../config";
import { modelTransport } from "../config";
import { createCompactionSummarizer } from "./summarizer";
import type { LlmIo } from "../tools/execution/llm";

/** Translate operator configuration into the callback-free run-scoped strategy. */
export function configuredCompaction(
  config: OpenOmniConfig,
  io: LlmIo = {},
): CompactionOptions {
  const transport = modelTransport(config.model);
  return {
    elideToolOutputs: { minOutputChars: 4000, keepHeadChars: 500 },
    ...(config.compactionSummarizer === false
      ? {}
      : {
          onSummarize: createCompactionSummarizer({
            model: { ...config.model, ...(transport === undefined ? {} : { transport }) },
            io,
          }),
        }),
  };
}
