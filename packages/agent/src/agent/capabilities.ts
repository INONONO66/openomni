import { z } from "zod";

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
