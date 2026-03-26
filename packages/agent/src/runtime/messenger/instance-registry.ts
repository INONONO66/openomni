export type InstanceStatus = "idle" | "busy" | "error";

export interface AgentInstance {
  instanceId: string;
  agentId: string;
  status: InstanceStatus;
  registeredAt: number;
  metadata?: Record<string, unknown>;
}

const store = new Map<string, AgentInstance>();

export namespace InstanceRegistry {
  export function register(
    instanceId: string,
    agentId: string,
    metadata?: Record<string, unknown>,
  ): void {
    store.set(instanceId, {
      instanceId,
      agentId,
      status: "idle",
      registeredAt: Date.now(),
      metadata,
    });
  }

  export function unregister(instanceId: string): void {
    store.delete(instanceId);
  }

  export function getById(instanceId: string): AgentInstance | undefined {
    return store.get(instanceId);
  }

  export function getByAgent(agentId: string): AgentInstance[] {
    return Array.from(store.values()).filter((i) => i.agentId === agentId);
  }

  export function updateStatus(instanceId: string, status: InstanceStatus): void {
    const instance = store.get(instanceId);
    if (!instance) throw new Error(`Instance '${instanceId}' not registered`);
    store.set(instanceId, { ...instance, status });
  }

  export function clear(): void {
    store.clear();
  }
}
