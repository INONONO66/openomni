import type { ChatAgentConfig } from "@openomni/agent";
import type { Policy, ToolSelection } from "@openomni/protocol";

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  // Agent definitions may use an alias/latest model ID. The server resolves it
  // to a concrete provider model ID before execution.
  readonly model: ChatAgentConfig["model"];
  readonly systemPrompt: string;
  readonly tools: ToolSelection.Selection;
  readonly permissions?: Policy.Permission;
  readonly policyPlan?: Policy.PolicyPlan;
  readonly budget?: ChatAgentConfig["budget"];
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
