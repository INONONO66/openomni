import { z } from "zod";
import { AgentProfile } from "../agent/index.js";
import { Policy } from "../policy/index.js";
import { Tool } from "../tool/index.js";
import { ToolSelection } from "../tool-selection/index.js";

export namespace WorkerBootstrap {
  export const RuntimeAgentDefinition = z.object({
    name: z.string(),
    description: z.string(),
    model: z
      .object({
        provider: z.string(),
        id: z.string(),
      })
      .optional(),
    systemPrompt: z.string().optional(),
    tools: ToolSelection.Selection,
    permissions: Policy.Permission.optional(),
    budget: AgentProfile.AgentBudget.optional(),
  });
  export type RuntimeAgentDefinition = z.infer<typeof RuntimeAgentDefinition>;

  export const RuntimeToolCatalogEntry = z.object({
    canonicalName: z.string(),
    exposedName: z.string(),
    source: z.enum(["system", "agent", "mcp", "server"]),
    category: ToolSelection.Category,
    riskTier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    spec: Tool.Spec,
    mcpServer: z.string().optional(),
  });
  export type RuntimeToolCatalogEntry = z.infer<typeof RuntimeToolCatalogEntry>;

  export const WorkerSnapshot = z.object({
    activeRuns: z.string().array(),
    backgroundTasks: z
      .object({
        id: z.string(),
        status: z.string(),
      })
      .array(),
    lastHeartbeat: z.number(),
    memoryRss: z.number(),
    configEpoch: z.string(),
  });
  export type WorkerSnapshot = z.infer<typeof WorkerSnapshot>;

  export const Bootstrap = z.object({
    configEpoch: z.string(),
    agents: RuntimeAgentDefinition.array(),
    toolCatalog: RuntimeToolCatalogEntry.array(),
    credentials: z.record(z.string()).optional(),
    policyPlan: Policy.PolicyPlan.optional(),
  });
  export type Bootstrap = z.infer<typeof Bootstrap>;
}
