import { z } from "zod";
import { randomUUID } from "crypto";

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

/**
 * Agent Capabilities - Explicit capabilities available to an agent
 * Used by the router when matching tasks to agents
 */
export const AgentCapabilitiesSchema = z.object({
  skills: z
    .array(z.string())
    .optional()
    .describe("Skills available to this agent"),
  tools: z
    .array(z.string())
    .optional()
    .describe("Tools available to this agent"),
  toolAllowlist: z
    .array(z.string())
    .optional()
    .describe("Explicit allowlist of tools"),
  toolDenylist: z
    .array(z.string())
    .optional()
    .describe("Explicit denylist of tools"),
});

export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/**
 * Policy Specification - Permission and capability constraints
 * Attaches to agents and can be tightened per edge
 */
export const DataScopeSchema = z.union([
  z.object({
    type: z.literal("files"),
    allow: z.enum(["read", "write", "none"]),
    roots: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("network"),
    allow: z.enum(["none", "egress"]),
    domains: z.array(z.string()).optional(),
  }),
]);

export type DataScope = z.infer<typeof DataScopeSchema>;

export const PolicySpecSchema = z.object({
  tools: z.array(z.string()).describe("Tools allowed by this policy"),
  dataScopes: z
    .array(DataScopeSchema)
    .optional()
    .describe("Data access scopes"),
  capabilities: z
    .array(z.enum(["delegate", "escalate", "override_router"]))
    .optional()
    .describe("Special capabilities granted"),
});

export type PolicySpec = z.infer<typeof PolicySpecSchema>;

/**
 * Agent Runtime State - Ephemeral status information
 * Changes frequently and is separate from identity
 */
export const AgentStatusSchema = z.enum([
  "idle",
  "busy",
  "degraded",
  "offline",
]);

export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentRuntimeSchema = z.object({
  instanceId: z.string().describe("Instance identifier"),
  agentId: z.string().describe("Agent profile identifier"),
  status: AgentStatusSchema.describe("Current runtime status"),
  currentTaskId: z.string().optional().describe("Currently executing task"),
  lastHeartbeatAt: z.number().optional().describe("Last heartbeat timestamp"),
  lastError: z.string().optional().describe("Last error message"),
});

export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

/**
 * Agent Registry - In-memory registry for agent profiles
 * Manages registration, lookup, and lifecycle of agent profiles
 */
export class AgentRegistry {
  private profiles: Map<string, AgentProfile> = new Map();

  /**
   * Register a new agent profile
   * @param profile The agent profile to register
   * @throws Error if profile with same ID already exists
   */
  set(profile: AgentProfile): void {
    if (this.profiles.has(profile.id)) {
      throw new Error(`Agent profile with id "${profile.id}" already exists`);
    }
    const validated = AgentProfileSchema.parse(profile);
    this.profiles.set(validated.id, validated);
  }

  /**
   * Retrieve an agent profile by ID
   * @param id The agent profile ID
   * @returns The agent profile or undefined if not found
   */
  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  /**
   * List all registered agent profiles
   * @returns Array of all registered profiles
   */
  list(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Remove an agent profile by ID
   * @param id The agent profile ID
   * @returns true if profile was removed, false if not found
   */
  remove(id: string): boolean {
    return this.profiles.delete(id);
  }

  /**
   * Check if an agent profile exists
   * @param id The agent profile ID
   * @returns true if profile exists
   */
  has(id: string): boolean {
    return this.profiles.has(id);
  }

  /**
   * Clear all registered profiles
   */
  clear(): void {
    this.profiles.clear();
  }

  /**
   * Get the count of registered profiles
   */
  size(): number {
    return this.profiles.size;
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

/**
 * Create a new agent runtime state
 * @param identity The agent identity
 * @returns A new agent runtime with idle status
 */
export function createAgentRuntime(identity: AgentIdentity): AgentRuntime {
  return AgentRuntimeSchema.parse({
    instanceId: identity.instanceId,
    agentId: identity.agentId,
    status: "idle",
    lastHeartbeatAt: Date.now(),
  });
}
