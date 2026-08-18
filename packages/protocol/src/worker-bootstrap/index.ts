import { z } from "zod";
import { Actor } from "../actor/index.js";
import { Model } from "../model/index.js";
import { Policy } from "../policy/index.js";
import { Tool } from "../tool/index.js";
import { ToolSelection } from "../tool-selection/index.js";

export namespace WorkerBootstrap {
  export const RuntimeAgentDefinition = z.object({
    name: z.string(),
    description: z.string(),
    model: Model.Ref.optional(),
    systemPrompt: z.string().optional(),
    tools: ToolSelection.Selection,
    permissions: Policy.Permission.optional(),
    policyPlan: Policy.PolicyPlan.optional(),
    budget: Actor.Profile.Budget.optional(),
  });
  export type RuntimeAgentDefinition = z.infer<typeof RuntimeAgentDefinition>;

  export const RuntimeToolCatalogEntry = z.object({
    canonicalName: z.string(),
    exposedName: z.string(),
    source: Tool.Source,
    category: ToolSelection.Category,
    riskTier: Tool.RiskTier,
    spec: Tool.Spec,
    descriptor: Policy.Resource.Descriptor.optional(),
    mcpServer: z.string().optional(),
  });
  export type RuntimeToolCatalogEntry = z.infer<typeof RuntimeToolCatalogEntry>;

  export const Bootstrap = z.object({
    configEpoch: z.string(),
    agents: RuntimeAgentDefinition.array(),
    toolCatalog: RuntimeToolCatalogEntry.array(),
    credentials: z.record(z.string()).optional(),
    policyPlan: Policy.PolicyPlan.optional(),
  });
  export type Bootstrap = z.infer<typeof Bootstrap>;
}
