import type { AgentProfile } from "@openomni/protocol";

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

export interface AgentRuntimeContext {
  readonly registry: AgentRegistryStore;
}

export function createAgentRuntimeContext(): AgentRuntimeContext {
  const agentDefinitions = new Map<string, AgentProfile.Definition>();

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
  };
}

let defaultContext: AgentRuntimeContext | undefined;

export function getDefaultContext(): AgentRuntimeContext {
  defaultContext ??= createAgentRuntimeContext();
  return defaultContext;
}
