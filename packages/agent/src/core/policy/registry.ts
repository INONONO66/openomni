import type { BusEvent } from "@openomni/protocol";
import { PolicyRegistry } from "@openomni/policy";
import type { PolicyRegistryInstance } from "@openomni/policy";
import { z } from "zod";
import type { CompactionOptions } from "../execution/compaction";
import { createCompactionPolicy } from "./builtin";
import type { PolicyContext } from "./types";

export { PolicyRegistry } from "@openomni/policy";
export type { PolicyFactory, PolicyRegistryInstance } from "@openomni/policy";

const MessageSummarizerSchema = z.custom<CompactionOptions["onSummarize"]>(
  (value) => typeof value === "function",
);

const CompactionConfigSchema: z.ZodType<CompactionOptions, z.ZodTypeDef, unknown> = z.object({
  contextWindowTokens: z.number(),
  thresholdRatio: z.number().optional(),
  reserveTokens: z.number().optional(),
  reserveRatio: z.number().optional(),
  protectRecentMessages: z.number().optional(),
  onSummarize: MessageSummarizerSchema.optional(),
});

function parseCompactionConfig(config: unknown): CompactionOptions {
  return CompactionConfigSchema.parse(config);
}

/**
 * @param events Where the built-ins that report send their records. Passed in
 * rather than reached for: a policy decides, and where the evidence of that
 * decision goes is the composition root's call.
 */
export function defaultRegistry(events: BusEvent.Sink): PolicyRegistryInstance<PolicyContext> {
  const registry = PolicyRegistry.create<PolicyContext>();

  registry.register("builtin:compaction", (config) =>
    createCompactionPolicy({ ...parseCompactionConfig(config), events }),
  );

  return registry;
}
