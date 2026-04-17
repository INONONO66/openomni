import type { AgentFactory, AgentDefinition, AgentPromptMetadata } from "../types";
import { DEV_AGENT_PROMPT } from "./prompt";

export const devAgentMeta: AgentPromptMetadata = {
  name: "dev",
  description: "Software development agent — coding, debugging, refactoring",
  triggers: {
    slashCommand: "dev",
    channels: ["dev", "development"],
  },
};

export const createDevAgent: AgentFactory = (): AgentDefinition => ({
  name: "dev",
  description: devAgentMeta.description,
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  systemPrompt: DEV_AGENT_PROMPT,
  tools: { categories: ["filesystem", "execution", "delegation"] },
  budget: {
    maxTurns: 24,
    maxToolCalls: 80,
  },
});
