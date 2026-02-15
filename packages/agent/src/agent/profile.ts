import { z } from "zod";
import { randomUUID } from "crypto";
import { PolicySpecSchema, AgentCapabilitiesSchema } from "./capabilities";

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
