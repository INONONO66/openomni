import type { BusEvent } from "@openomni/protocol";
import { PolicyRegistry } from "@openomni/policy";
import type { PolicyRegistryInstance } from "@openomni/policy";
import { Policy } from "@openomni/protocol";
import { z } from "zod";
import type { CompactionOptions } from "../execution/compaction";
import { createCompactionPolicy, createToolPermissionPolicy } from "./builtin";
import type { ToolPermissionPolicyConfig } from "./builtin/tool-guard";
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

/**
 * Wire shape only: the output type omits `events`, and a plain `z.object`
 * strips what the shape does not name. A policy plan therefore cannot smuggle
 * a sink of its own and redirect where the evidence of its own decision goes.
 */
const ToolPermissionConfigSchema: z.ZodType<
  Omit<ToolPermissionPolicyConfig, "events">,
  z.ZodTypeDef,
  unknown
> = z.object({ permission: Policy.Permission });

function parseCompactionConfig(config: unknown): CompactionOptions {
  return CompactionConfigSchema.parse(config);
}

function parseToolPermissionConfig(config: unknown): Omit<ToolPermissionPolicyConfig, "events"> {
  return ToolPermissionConfigSchema.parse(
    config === undefined ? { permission: { action: "tool.call" } } : config,
  );
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
  registry.register("builtin:tool-permission", (config) =>
    createToolPermissionPolicy({ ...parseToolPermissionConfig(config), events }),
  );

  return registry;
}
