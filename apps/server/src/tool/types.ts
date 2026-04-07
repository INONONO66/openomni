import type { Guardrail, Tool } from "@openomni/protocol";

export type ToolCategory = "system" | "agent" | "mcp";

export type ToolRiskTier = 0 | 1 | 2 | 3;
// Tier 0: read-only (fs.read, fs.list)
// Tier 1: local write (fs.write)
// Tier 2: shell exec, git push — logged, future approval gate
// Tier 3: reserved

export interface NativeTool {
  spec: Tool.Spec;
  riskTier: ToolRiskTier;
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
