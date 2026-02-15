import { AgentProfileSchema, type AgentProfile } from "./profile";

export interface AgentRegistryStore {
  get(id: string): AgentProfile | undefined;
  set(id: string, profile: AgentProfile): void;
  list(): AgentProfile[];
  remove(id: string): boolean;
  has(id: string): boolean;
  clear(): void;
  size(): number;
}

export class InMemoryAgentRegistryStore implements AgentRegistryStore {
  private profiles = new Map<string, AgentProfile>();

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  set(id: string, profile: AgentProfile): void {
    this.profiles.set(id, profile);
  }

  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  remove(id: string): boolean {
    return this.profiles.delete(id);
  }

  has(id: string): boolean {
    return this.profiles.has(id);
  }

  clear(): void {
    this.profiles.clear();
  }

  size(): number {
    return this.profiles.size;
  }
}

export class AgentRegistry {
  private static defaultStore: AgentRegistryStore | undefined;

  static configure(store: AgentRegistryStore): void {
    AgentRegistry.defaultStore = store;
  }

  static getStore(): AgentRegistryStore | undefined {
    return AgentRegistry.defaultStore;
  }

  static reset(): void {
    AgentRegistry.defaultStore = undefined;
  }

  private store: AgentRegistryStore;

  constructor(store?: AgentRegistryStore) {
    this.store =
      store ?? AgentRegistry.defaultStore ?? new InMemoryAgentRegistryStore();
  }

  /**
   * Register a new agent profile
   * @param profile The agent profile to register
   * @throws Error if profile with same ID already exists
   */
  set(profile: AgentProfile): void {
    if (this.store.has(profile.id)) {
      throw new Error(`Agent profile with id "${profile.id}" already exists`);
    }
    const validated = AgentProfileSchema.parse(profile);
    this.store.set(validated.id, validated);
  }

  /**
   * Retrieve an agent profile by ID
   * @param id The agent profile ID
   * @returns The agent profile or undefined if not found
   */
  get(id: string): AgentProfile | undefined {
    return this.store.get(id);
  }

  /**
   * List all registered agent profiles
   * @returns Array of all registered profiles
   */
  list(): AgentProfile[] {
    return this.store.list();
  }

  /**
   * Remove an agent profile by ID
   * @param id The agent profile ID
   * @returns true if profile was removed, false if not found
   */
  remove(id: string): boolean {
    return this.store.remove(id);
  }

  /**
   * Check if an agent profile exists
   * @param id The agent profile ID
   * @returns true if profile exists
   */
  has(id: string): boolean {
    return this.store.has(id);
  }

  /**
   * Clear all registered profiles
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get the count of registered profiles
   */
  size(): number {
    return this.store.size();
  }
}
