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
  model: { provider: "anthropic", id: "claude-opus-4-5" },
  systemPrompt: DEV_AGENT_PROMPT,
  tools: {
    system: true,
    agent: ["subagent"],
    mcp: false,
  },
  budget: {
    maxTurns: 24,
    maxToolCalls: 80,
  },
  permissions: {
    denylist: ["git.push"],
  },
});
