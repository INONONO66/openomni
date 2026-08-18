import type { Policy, Tool, ToolSelection } from "@openomni/protocol";

export type ToolCategory = "system" | "agent" | "mcp";
export type ToolMetaValue = boolean | ((input: unknown) => boolean);
export type ToolSource = Tool.Source;
export type ToolRiskTier = Tool.RiskTier;
// Tier 0: read-only (read, glob, grep.search)
// Tier 1: local write (write, edit)
// Tier 2: bash — logged, future approval gate
// Tier 3: reserved

export type ImplicitInputSource = "sessionId" | "runId" | "agentName" | "workspaceRoot";

export interface ToolRuntimeContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly agentName?: string;
  readonly workspaceRoot?: string;
}

export type ToolExecutionContext = Tool.ExecutionContext;

export interface NativeTool {
  spec: Tool.Spec;
  riskTier: ToolRiskTier;
  isReadOnly: ToolMetaValue;
  isDestructive: ToolMetaValue;
  isConcurrencySafe: ToolMetaValue;
  labels?: readonly string[];
  descriptor?: Policy.Resource.Descriptor;
  source?: ToolSource;
  category?: ToolSelection.Category;
  implicitInputs?: Readonly<Record<string, ImplicitInputSource>>;
  execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result>;
}

export interface ToolProvider {
  readonly name: string;
  readonly category: ToolCategory;
  listTools(): NativeTool[];
  execute(call: Tool.Call, context?: ToolExecutionContext): Promise<Tool.Result>;
}

export interface ToolExecutorConfig {
  permissions?: Policy.Permission;
  workspaceRoot?: string;
  runtime?: ToolRuntimeContext;
  timeoutMs?: {
    tier0?: number;
    tier1?: number;
    tier2?: number;
  };
  postTimeoutSettleGraceMs?: number;
}
