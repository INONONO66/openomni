import { z } from "zod";
import { randomUUID } from "crypto";

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
    .array(z.enum(["delegate", "escalate"]))
    .optional()
    .describe("Special capabilities granted"),
});

export type PolicySpec = z.infer<typeof PolicySpecSchema>;

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
 * Agent Runtime State - Ephemeral status information
 * Changes frequently and is separate from identity
 */
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
