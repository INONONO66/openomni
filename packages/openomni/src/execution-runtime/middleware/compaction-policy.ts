import { createCompactionPolicy } from "@openomni/agent";
import type { CompactionOptions, PolicyContext, PolicyRegistryInstance } from "@openomni/agent";
import type { BusEvent, Message } from "@openomni/protocol";
import { z } from "zod";

const MessageSummarizerSchema = z.custom<(messages: Message.WithParts[]) => Promise<string>>(
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

/**
 * Ordering opinion, stated where opinions live: compaction runs after every
 * product policy at run.completion.pre has had its say about the messages it
 * is about to rewrite.
 */
export const COMPACTION_PRIORITY = 900;

/**
 * Registers the compaction strategy. The mechanism — measurement, the cut,
 * the boundary guard, the run.completion.pre seam — is the agent core's
 * (D6/D8); when to trigger and how to summarize arrive here, as config
 * hydrated from the gate-stamped policy plan.
 */
export function registerCompaction(
  registry: PolicyRegistryInstance<PolicyContext>,
  events: BusEvent.Sink,
): void {
  registry.register("builtin:compaction", (config) =>
    createCompactionPolicy({
      ...CompactionConfigSchema.parse(config),
      events,
      priority: COMPACTION_PRIORITY,
    }),
  );
}
