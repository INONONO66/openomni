import { getDefaultContext } from "../../core/runtime-context";
import type { RuntimeAgentInstance, RuntimeInstanceStatus } from "../../core/runtime-context";

export type InstanceStatus = RuntimeInstanceStatus;

export type AgentInstance = RuntimeAgentInstance;

export namespace InstanceRegistry {
  export function register(
    instanceId: string,
    agentId: string,
    metadata?: Record<string, unknown>,
  ): () => void {
    return getDefaultContext().instances.register(instanceId, agentId, metadata);
  }

  export function unregister(instanceId: string): void {
    getDefaultContext().instances.unregister(instanceId);
  }

  export function getById(instanceId: string): AgentInstance | undefined {
    return getDefaultContext().instances.getById(instanceId);
  }

  export function getByAgent(agentId: string): AgentInstance[] {
    return getDefaultContext().instances.getByAgent(agentId);
  }

  export function updateStatus(instanceId: string, status: InstanceStatus): void {
    getDefaultContext().instances.updateStatus(instanceId, status);
  }

  export function clear(): void {
    getDefaultContext().instances.clear();
  }
}
