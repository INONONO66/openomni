import type { ChatAgentConfig } from "@openomni/agent";
import type { WorkerBootstrap } from "@openomni/protocol";

type RuntimeAgentModel = NonNullable<WorkerBootstrap.AgentDefinition["model"]>;
type AssertRuntimeModelCompatible<T extends RuntimeAgentModel> = T;
type _AgentDefinitionModelCompatibility = AssertRuntimeModelCompatible<ChatAgentConfig["model"]>;

export type AgentDefinition = WorkerBootstrap.AgentDefinition & {
  // Agent definitions may use an alias/latest model ID. The server resolves it
  // to a concrete provider model ID from models.dev before execution.
  model: ChatAgentConfig["model"];
  systemPrompt: string;
};

export type AgentFactory = () => AgentDefinition;

export interface AgentPromptMetadata {
  name: string;
  description: string;
  triggers?: {
    slashCommand?: string;
    channels?: string[];
  };
}
