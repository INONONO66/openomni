import type { AgentProfile } from "@openomni/protocol";

const store = new Map<string, AgentProfile.Definition>();

export namespace AgentRegistry {
  export function define(definition: AgentProfile.Definition): void {
    store.set(definition.name, definition);
  }

  export function get(name: string): AgentProfile.Definition | undefined {
    return store.get(name);
  }

  export function has(name: string): boolean {
    return store.has(name);
  }

  export function list(): AgentProfile.Definition[] {
    return Array.from(store.values());
  }

  export function override(name: string, partial: Partial<AgentProfile.Definition>): void {
    const existing = store.get(name);
    if (!existing) throw new Error(`Agent '${name}' not registered`);
    store.set(name, { ...existing, ...partial });
  }

  export function clear(): void {
    store.clear();
  }

  export function replaceAll(defs: AgentProfile.Definition[]): void {
    store.clear();
    for (const def of defs) {
      store.set(def.name, def);
    }
  }
}
