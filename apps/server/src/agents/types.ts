import type { AgentBudget, ChatAgentConfig } from "@openomni/agent";
import type { Policy, ToolSelection } from "@openomni/protocol";

export interface AgentDefinition {
  name: string;
  description: string;
  // Agent definitions may use an alias/latest model ID. The server resolves it
  // to a concrete provider model ID from models.dev before execution.
  model: ChatAgentConfig["model"];
  systemPrompt: string;
  tools: ToolSelection.Selection;
  budget?: AgentBudget;
  permissions?: Policy.Permission;
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
