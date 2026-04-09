import type { Guardrail, Tool } from "@openomni/protocol";

export type ToolCategory = "system" | "agent" | "mcp";
export type ToolMetaValue = boolean | ((input: unknown) => boolean);
export type ToolSource = "system" | "mcp" | "agent";

export type ToolRiskTier = 0 | 1 | 2 | 3;
// Tier 0: read-only (read, glob, grep.search)
// Tier 1: local write (write, edit)
// Tier 2: bash — logged, future approval gate
// Tier 3: reserved

export interface NativeTool {
  spec: Tool.Spec;
  prompt?: string;
  riskTier: ToolRiskTier;
  isReadOnly: ToolMetaValue;
  isDestructive: ToolMetaValue;
  isConcurrencySafe: ToolMetaValue;
  source?: ToolSource;
  execute(call: Tool.Call): Promise<Tool.Result>;
}

export interface ToolProvider {
  readonly name: string;
  readonly category: ToolCategory;
  listTools(): NativeTool[];
  execute(call: Tool.Call): Promise<Tool.Result>;
}

export interface ToolExecutorConfig {
  permissions?: Guardrail.ToolPermission;
  workspaceRoot?: string;
  timeoutMs?: {
    tier0?: number;
    tier1?: number;
    tier2?: number;
  };
}
