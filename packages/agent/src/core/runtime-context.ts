import type { AgentProfile, Messenger } from "@openomni/protocol";

export type RuntimeInstanceStatus = "idle" | "busy" | "error";

export interface RuntimeAgentInstance {
  readonly instanceId: string;
  readonly agentId: string;
  readonly status: RuntimeInstanceStatus;
  readonly registeredAt: number;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentRegistryStore {
  define(definition: AgentProfile.Definition): void;
  get(name: string): AgentProfile.Definition | undefined;
  has(name: string): boolean;
  list(): AgentProfile.Definition[];
  override(name: string, partial: Partial<AgentProfile.Definition>): void;
  clear(): void;
  replaceAll(defs: AgentProfile.Definition[]): void;
}

export interface InstanceRegistryStore {
  register(instanceId: string, agentId: string, metadata?: Record<string, unknown>): () => void;
  unregister(instanceId: string): void;
  getById(instanceId: string): RuntimeAgentInstance | undefined;
  getByAgent(agentId: string): RuntimeAgentInstance[];
  updateStatus(instanceId: string, status: RuntimeInstanceStatus): void;
  clear(): void;
}

export interface MessageLogStore {
  append(envelope: Messenger.MessageEnvelope): void;
  getLog(): Messenger.MessageEnvelope[];
  reset(): void;
}

export interface AgentRuntimeContext {
  readonly registry: AgentRegistryStore;
  readonly instances: InstanceRegistryStore;
  readonly messageLog: MessageLogStore;
}

const MAX_MESSAGE_LOG_SIZE = 1000;

export function createAgentRuntimeContext(): AgentRuntimeContext {
  const agentDefinitions = new Map<string, AgentProfile.Definition>();
  const instances = new Map<string, RuntimeAgentInstance>();
  const messageLog: Messenger.MessageEnvelope[] = [];

  const instanceStore: InstanceRegistryStore = {
    register(instanceId: string, agentId: string, metadata?: Record<string, unknown>): () => void {
      instances.set(instanceId, {
        instanceId,
        agentId,
        status: "idle",
        registeredAt: Date.now(),
        metadata,
      });
      return () => instanceStore.unregister(instanceId);
    },

    unregister(instanceId: string): void {
      instances.delete(instanceId);
    },

    getById(instanceId: string): RuntimeAgentInstance | undefined {
      return instances.get(instanceId);
    },

    getByAgent(agentId: string): RuntimeAgentInstance[] {
      return Array.from(instances.values()).filter((instance) => instance.agentId === agentId);
    },

    updateStatus(instanceId: string, status: RuntimeInstanceStatus): void {
      const instance = instances.get(instanceId);
      if (!instance) throw new Error(`Instance '${instanceId}' not registered`);
      instances.set(instanceId, { ...instance, status });
    },

    clear(): void {
      instances.clear();
    },
  };

  return {
    registry: {
      define(definition: AgentProfile.Definition): void {
        agentDefinitions.set(definition.name, definition);
      },

      get(name: string): AgentProfile.Definition | undefined {
        return agentDefinitions.get(name);
      },

      has(name: string): boolean {
        return agentDefinitions.has(name);
      },

      list(): AgentProfile.Definition[] {
        return Array.from(agentDefinitions.values());
      },

      override(name: string, partial: Partial<AgentProfile.Definition>): void {
        const existing = agentDefinitions.get(name);
        if (!existing) throw new Error(`Agent '${name}' not registered`);
        agentDefinitions.set(name, { ...existing, ...partial });
      },

      clear(): void {
        agentDefinitions.clear();
      },

      replaceAll(defs: AgentProfile.Definition[]): void {
        agentDefinitions.clear();
        for (const def of defs) {
          agentDefinitions.set(def.name, def);
        }
      },
    },

    instances: instanceStore,

    messageLog: {
      append(envelope: Messenger.MessageEnvelope): void {
        if (messageLog.length >= MAX_MESSAGE_LOG_SIZE) {
          messageLog.splice(0, Math.floor(MAX_MESSAGE_LOG_SIZE / 2));
        }
        messageLog.push(envelope);
      },

      getLog(): Messenger.MessageEnvelope[] {
        return [...messageLog];
      },

      reset(): void {
        messageLog.length = 0;
      },
    },
  };
}

let defaultContext: AgentRuntimeContext | undefined;

export function getDefaultContext(): AgentRuntimeContext {
  defaultContext ??= createAgentRuntimeContext();
  return defaultContext;
}
