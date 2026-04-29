import type { AgentProfile } from "@openomni/protocol";
import { getDefaultContext } from "../../core/runtime-context";

export namespace AgentRegistry {
  export function define(definition: AgentProfile.Definition): void {
    getDefaultContext().registry.define(definition);
  }

  export function get(name: string): AgentProfile.Definition | undefined {
    return getDefaultContext().registry.get(name);
  }

  export function has(name: string): boolean {
    return getDefaultContext().registry.has(name);
  }

  export function list(): AgentProfile.Definition[] {
    return getDefaultContext().registry.list();
  }

  export function override(name: string, partial: Partial<AgentProfile.Definition>): void {
    getDefaultContext().registry.override(name, partial);
  }

  export function clear(): void {
    getDefaultContext().registry.clear();
  }

  export function replaceAll(defs: AgentProfile.Definition[]): void {
    getDefaultContext().registry.replaceAll(defs);
  }
}
