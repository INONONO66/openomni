import type { Tool as ProtocolTool } from "@openomni/protocol";
import type { NativeTool, ToolMetaValue, ToolRiskTier, ToolSource } from "./types";

const TOOL_DEFAULTS = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
} as const;

const defaultRiskTier: ToolRiskTier = 1;

export interface ToolDefinition<TInput = Record<string, unknown>> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: ProtocolTool.Spec["inputSchema"];
  readonly prompt?: string;
  readonly safe?: boolean;
  readonly riskTier?: ToolRiskTier;
  readonly isReadOnly?: ToolMetaValue;
  readonly isDestructive?: ToolMetaValue;
  readonly isConcurrencySafe?: ToolMetaValue;
  readonly source?: ToolSource;
  execute(
    call: ProtocolTool.Call & { input: TInput extends Record<string, unknown> ? TInput : never },
  ): Promise<ProtocolTool.Result>;
}

export function resolveMeta(value: ToolMetaValue, input: unknown): boolean {
  return typeof value === "function" ? value(input) : value;
}

export function defineTool<TInput>(def: ToolDefinition<TInput>): NativeTool {
  const isReadOnly = def.isReadOnly ?? TOOL_DEFAULTS.isReadOnly;
  const isDestructive = def.isDestructive ?? TOOL_DEFAULTS.isDestructive;
  const isConcurrencySafe = def.isConcurrencySafe ?? TOOL_DEFAULTS.isConcurrencySafe;
  const safe = def.safe ?? (typeof isReadOnly === "boolean" ? isReadOnly : undefined);

  return {
    spec: {
      name: def.name,
      ...(def.description ? { description: def.description } : {}),
      inputSchema: def.inputSchema,
      ...(safe !== undefined ? { safe } : {}),
      ...(def.prompt ? { prompt: def.prompt } : {}),
    },
    ...(def.prompt ? { prompt: def.prompt } : {}),
    riskTier: def.riskTier ?? defaultRiskTier,
    isReadOnly,
    isDestructive,
    isConcurrencySafe,
    source: def.source ?? "system",
    execute: def.execute as NativeTool["execute"],
  };
}

export const Tool = {
  define: defineTool,
} as const;
