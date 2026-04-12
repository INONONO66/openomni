import type { AgentBudget, ChatAgentConfig } from "@openomni/agent";
import type { Guardrail } from "@openomni/protocol";

export interface AgentToolSelection {
  system?: boolean | string[]; // true = all, string[] = specific tool names
  agent?: boolean | string[];
  mcp?: boolean | string[]; // string[] = specific server names
}

export interface AgentDefinition {
  name: string;
  description: string;
  model: ChatAgentConfig["model"];
  systemPrompt: string;
  tools: AgentToolSelection;
  budget?: AgentBudget;
  permissions?: Guardrail.ToolPermission;
}

export type AgentFactory = () => AgentDefinition;

export interface AgentPromptMetadata {
  name: string;
  description: string;
  triggers?: {
    slashCommand?: string;
    channels?: string[];
  };
}
