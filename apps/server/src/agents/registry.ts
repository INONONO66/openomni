import type { AgentFactory, AgentDefinition, AgentPromptMetadata } from "./types";
import { createDevAgent, devAgentMeta } from "./dev-agent/index";
import { createPlanAgent, planAgentMeta } from "./plan-agent/index";

const agentSources = new Map<string, AgentFactory>([
  ["dev", createDevAgent],
  ["plan", createPlanAgent],
]);
const metadata = new Map<string, AgentPromptMetadata>([
  ["dev", devAgentMeta],
  ["plan", planAgentMeta],
]);

export function registerAgent(factory: AgentFactory, meta: AgentPromptMetadata): void {
  agentSources.set(meta.name, factory);
  metadata.set(meta.name, meta);
}

export { metadata as agentMetadata };

export function getAgentDefinition(name: string): AgentDefinition | undefined {
  const factory = agentSources.get(name);
  return factory?.();
}

export function getAllAgentNames(): string[] {
  return [...agentSources.keys()];
}

export function createAllAgents(): Map<string, AgentDefinition> {
  const result = new Map<string, AgentDefinition>();
  for (const [name, factory] of agentSources) {
    result.set(name, factory());
  }
  return result;
}
