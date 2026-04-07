import type { AgentFactory, AgentDefinition, AgentPromptMetadata } from "./types";
import { createDevAgent, devAgentMeta } from "./dev-agent/index";

const agentSources: Map<string, AgentFactory> = new Map([["dev", createDevAgent]]);

export const agentMetadata: Map<string, AgentPromptMetadata> = new Map([["dev", devAgentMeta]]);

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
