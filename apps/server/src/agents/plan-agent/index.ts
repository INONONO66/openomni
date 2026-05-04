import type { AgentFactory, AgentDefinition, AgentPromptMetadata } from "../types";
import { PLAN_AGENT_PROMPT } from "./prompt";

export const planAgentMeta: AgentPromptMetadata = {
  name: "plan",
  description: "Plan generator",
  triggers: { slashCommand: "plan" },
};

export const createPlanAgent: AgentFactory = (): AgentDefinition => ({
  name: "plan",
  description: "Plan generator — creates structured work plans",
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  systemPrompt: PLAN_AGENT_PROMPT,
  tools: {
    categories: ["filesystem", "execution"],
    allow: ["plan_read", "plan_write", "plan_edit", "plan_list"],
  },
  budget: { maxTurns: 12, maxToolCalls: 30 },
  permissions: { action: "tool.call", denylist: ["write", "edit"] },
});
