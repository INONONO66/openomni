import type { RuntimeResource, Tool as ProtocolTool } from "@openomni/protocol";
import type {
  ImplicitInputSource,
  NativeTool,
  ToolExecutionContext,
  ToolMetaValue,
  ToolRiskTier,
  ToolSource,
} from "./types.js";

const TOOL_DEFAULTS = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
} as const;

const defaultRiskTier: ToolRiskTier = 1;

function descriptorSource(source: ToolSource): RuntimeResource.Source {
  return { type: source };
}

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
  readonly labels?: readonly string[];
  readonly source?: ToolSource;
  readonly implicitInputs?: Readonly<Record<string, ImplicitInputSource>>;
  execute(
    call: ProtocolTool.Call & { input: TInput extends Record<string, unknown> ? TInput : never },
    context?: ToolExecutionContext,
  ): Promise<ProtocolTool.Result>;
}

export function resolveMeta(value: ToolMetaValue, input: unknown): boolean {
  return typeof value === "function" ? value(input) : value;
}

function stripImplicitFields(
  schema: ProtocolTool.Spec["inputSchema"],
  implicitKeys: ReadonlySet<string>,
): ProtocolTool.Spec["inputSchema"] {
  if (!schema || implicitKeys.size === 0) return schema;
  const props = (schema as Record<string, unknown>).properties as
    | Record<string, unknown>
    | undefined;
  if (!props) return schema;

  const filtered = { ...props };
  for (const key of implicitKeys) delete filtered[key];

  const required = (schema as Record<string, unknown>).required as string[] | undefined;
  const filteredRequired = required?.filter((r) => !implicitKeys.has(r));

  return {
    ...schema,
    properties: filtered,
    ...(filteredRequired && filteredRequired.length > 0 ? { required: filteredRequired } : {}),
  };
}

export function defineTool<TInput>(def: ToolDefinition<TInput>): NativeTool {
  const isReadOnly = def.isReadOnly ?? TOOL_DEFAULTS.isReadOnly;
  const isDestructive = def.isDestructive ?? TOOL_DEFAULTS.isDestructive;
  const isConcurrencySafe = def.isConcurrencySafe ?? TOOL_DEFAULTS.isConcurrencySafe;
  const safe = def.safe ?? (typeof isReadOnly === "boolean" ? isReadOnly : undefined);

  const implicitKeys = def.implicitInputs
    ? new Set(Object.keys(def.implicitInputs))
    : new Set<string>();
  const publicSchema = stripImplicitFields(def.inputSchema, implicitKeys);
  const labels = [
    `tool:${def.name}`,
    `risk:tier-${def.riskTier ?? defaultRiskTier}`,
    `source:${def.source ?? "system"}`,
    ...(typeof isReadOnly === "boolean" && isReadOnly ? ["capability:read"] : []),
    ...(typeof isReadOnly === "boolean" && !isReadOnly ? ["capability:write"] : []),
    ...(typeof isDestructive === "boolean" && isDestructive ? ["capability:destructive"] : []),
    ...(def.labels ?? []),
  ];
  const capabilities = [
    ...(typeof isReadOnly === "boolean" && isReadOnly ? ["read"] : []),
    ...(typeof isReadOnly === "boolean" && !isReadOnly ? ["write"] : []),
  ];
  const effects = [...(typeof isDestructive === "boolean" && isDestructive ? ["destructive"] : [])];
  const source = def.source ?? "system";
  const descriptor: RuntimeResource.Descriptor = {
    id: `tool:${source}:${def.name}`,
    kind: "tool",
    source: descriptorSource(source),
    labels,
    capabilities,
    effects,
    risk: def.riskTier ?? defaultRiskTier,
  };

  const spec: ProtocolTool.Spec & { labels: string[] } = {
    name: def.name,
    ...(def.description ? { description: def.description } : {}),
    inputSchema: publicSchema,
    ...(safe !== undefined ? { safe } : {}),
    labels,
    ...(def.prompt ? { prompt: def.prompt } : {}),
  };

  return {
    spec,
    riskTier: def.riskTier ?? defaultRiskTier,
    isReadOnly,
    isDestructive,
    isConcurrencySafe,
    labels,
    descriptor,
    source,
    ...(def.implicitInputs ? { implicitInputs: def.implicitInputs } : {}),
    execute: def.execute as NativeTool["execute"],
  };
}

export const Tool = {
  define: defineTool,
} as const;
