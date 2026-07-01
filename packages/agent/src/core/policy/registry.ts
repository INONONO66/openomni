import { PolicyRegistry } from "@openomni/policy";
import { Policy } from "@openomni/protocol";
import { z } from "zod";
import type { CompactionOptions } from "../execution/compaction";
import type { AgentEventEmitter } from "../types";
import {
  createBudgetReassurancePolicy,
  createBudgetWarningPolicy,
  createCompactionPolicy,
  createIdleNudgePolicy,
  createToolPermissionPolicy,
} from "./builtin";
import type { IdleNudgeConfig } from "./builtin/idle-nudge";
import type { ToolPermissionPolicyConfig } from "./builtin/tool-guard";

export { PolicyRegistry } from "@openomni/policy";
export type { PolicyFactory, PolicyRegistryInstance, RuntimeContext } from "@openomni/policy";

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

const IdleNudgeConfigSchema: z.ZodType<IdleNudgeConfig, z.ZodTypeDef, unknown> = z.object({
  idleThresholdMs: z.number().optional(),
  maxNudges: z.number().optional(),
});

const AgentEventEmitterSchema = z.custom<AgentEventEmitter>(
  (value) => isRecord(value) && typeof value.emit === "function",
);

const ToolBlockedHandlerSchema = z.custom<ToolPermissionPolicyConfig["onToolBlocked"]>(
  (value) => typeof value === "function",
);

const ToolPermissionConfigSchema: z.ZodType<ToolPermissionPolicyConfig, z.ZodTypeDef, unknown> =
  z.object({
    permission: Policy.Permission,
    eventEmitter: AgentEventEmitterSchema.optional(),
    source: z.string().optional(),
    onToolBlocked: ToolBlockedHandlerSchema.optional(),
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCompactionConfig(config: unknown): CompactionOptions {
  return CompactionConfigSchema.parse(config);
}

function parseIdleNudgeConfig(config: unknown): IdleNudgeConfig {
  return IdleNudgeConfigSchema.parse(config ?? {});
}

function parseToolPermissionConfig(config: unknown): ToolPermissionPolicyConfig {
  return ToolPermissionConfigSchema.parse(
    config === undefined ? { permission: { action: "tool.call" } } : config,
  );
}

export function defaultRegistry(): ReturnType<typeof PolicyRegistry.create> {
  const registry = PolicyRegistry.create();

  registry.register("builtin:budget-reassurance", () => createBudgetReassurancePolicy());
  registry.register("builtin:budget-warning", () => createBudgetWarningPolicy());
  registry.register("builtin:compaction", (config) =>
    createCompactionPolicy(parseCompactionConfig(config)),
  );
  registry.register("builtin:idle-nudge", (config) =>
    createIdleNudgePolicy(parseIdleNudgeConfig(config)),
  );
  registry.register("builtin:tool-permission", (config) =>
    createToolPermissionPolicy(parseToolPermissionConfig(config)),
  );

  return registry;
}
