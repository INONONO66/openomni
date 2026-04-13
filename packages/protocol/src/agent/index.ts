import { z } from "zod";
import { Guardrail } from "../guardrail/index.js";

export namespace AgentProfile {
  export const AgentBudget = z.object({
    maxTurns: z.number().optional(),
    maxToolCalls: z.number().optional(),
    maxWallTimeMs: z.number().optional(),
    maxToolRuntimeMs: z.number().optional(),
  });
  export type AgentBudget = z.infer<typeof AgentBudget>;

  export const Definition = z.object({
    name: z.string(),
    description: z.string(),
    systemPrompt: z.string().optional(),
    tools: z.string().array().default([]),
    model: z
      .object({
        provider: z.string(),
        id: z.string(),
      })
      .optional(),
    permissions: Guardrail.ToolPermission.optional(),
    variant: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    budget: AgentBudget.optional(),
  });
  export type Definition = z.infer<typeof Definition>;
}
