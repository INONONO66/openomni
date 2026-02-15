import { z } from "zod";
import { randomUUID } from "crypto";
import { PolicySpecSchema, AgentCapabilitiesSchema } from "./capabilities";

/**
 * Agent Profile - Durable configuration for an agent
 * Represents the static definition of an agent's capabilities and constraints
 */
export const AgentProfileSchema = z.object({
  id: z.string().describe("Unique identifier for the agent profile"),
  name: z.string().describe("Human-readable name of the agent"),
  role: z.string().optional().describe("Role or specialization of the agent"),
  systemPrompt: z
    .string()
    .optional()
    .describe("System prompt to guide agent behavior"),
  skills: z
    .array(z.string())
    .optional()
    .describe("List of skills the agent possesses"),
  tools: z
    .array(z.string())
    .optional()
    .describe("List of tools the agent can use"),
  policy: z
    .lazy(() => PolicySpecSchema)
    .optional()
    .describe("Permission policy for the agent"),
});

export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * Agent Identity - Runtime instance of an agent
 * Represents a live instance with unique identity and capabilities
 */
export const AgentIdentitySchema = z.object({
  agentId: z.string().describe("Reference to the agent profile"),
  instanceId: z.string().describe("Unique instance identifier"),
  version: z.string().optional().describe("Version of the agent"),
  capabilities: z
    .lazy(() => AgentCapabilitiesSchema)
    .optional()
    .describe("Runtime capabilities of this instance"),
});

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

export const AgentStatusSchema = z.enum([
  "idle",
  "busy",
  "degraded",
  "offline",
]);

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

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

/**
 * Create a new agent identity instance from a profile
 * @param profile The agent profile
 * @param version Optional version string
 * @returns A new agent identity with generated instance ID
 */
export function createAgentIdentity(
  profile: AgentProfile,
  version?: string,
): AgentIdentity {
  return AgentIdentitySchema.parse({
    agentId: profile.id,
    instanceId: randomUUID(),
    version,
    capabilities: {
      skills: profile.skills,
      tools: profile.tools,
    },
  });
}
