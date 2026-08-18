import { z } from "zod";
import { Execution } from "../execution/index.js";
import { Model } from "../model/index.js";
import { Policy } from "../policy/index.js";
import { Tool } from "../tool/index.js";
import { ToolSelection } from "../tool-selection/index.js";

export namespace WorkerBootstrap {
  /**
   * #500 B1: an agent definition delivered at worker bootstrap. The spawn
   * config fields (`systemPrompt`/`permissions`/`policyPlan`/`budget`) are
   * PICKED from the canonical Execution.Request instead of re-declared —
   * the #504 dual lane (`permissions` + `policyPlan`) rides the same schema
   * objects the spawn parse enforces. Bootstrap-only extensions: identity
   * (`name`/`description`), a per-agent `model` override (optional here,
   * required on a spawn), and `tools` as a ToolSelection (resolved to
   * concrete Tool.Spec[] before a run is spawned).
   */
  export const AgentDefinition = Execution.Request.pick({
    systemPrompt: true,
    permissions: true,
    policyPlan: true,
    budget: true,
  }).extend({
    name: z.string(),
    description: z.string(),
    model: Model.Ref.optional(),
    tools: ToolSelection.Selection,
  });
  export type AgentDefinition = z.infer<typeof AgentDefinition>;

  export const ToolCatalogEntry = z.object({
    canonicalName: z.string(),
    exposedName: z.string(),
    source: Tool.Source,
    category: ToolSelection.Category,
    riskTier: Tool.RiskTier,
    spec: Tool.Spec,
    descriptor: Policy.Resource.Descriptor.optional(),
    mcpServer: z.string().optional(),
  });
  export type ToolCatalogEntry = z.infer<typeof ToolCatalogEntry>;

  export const Bootstrap = z.object({
    configEpoch: z.string(),
    agents: AgentDefinition.array(),
    toolCatalog: ToolCatalogEntry.array(),
    credentials: z.record(z.string()).optional(),
    policyPlan: Policy.PolicyPlan.optional(),
  });
  export type Bootstrap = z.infer<typeof Bootstrap>;
}
