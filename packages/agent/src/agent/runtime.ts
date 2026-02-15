import { z } from "zod";
import { AgentStatusSchema } from "./profile";
import type { AgentIdentity } from "./profile";

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
