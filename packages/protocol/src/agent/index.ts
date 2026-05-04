import { z } from "zod";
import { Guardrail } from "../guardrail/index.js";

export namespace AgentProfile {
  const budgetLimit = z
    .number()
    .int()
    .refine((n) => n === -1 || n > 0, {
      message: "must be a positive integer or -1 (unlimited)",
    });

  export const AgentBudget = z.object({
    maxTurns: budgetLimit.optional(),
    maxToolCalls: budgetLimit.optional(),
    maxWallTimeMs: z
      .number()
      .refine((n) => n === -1 || n > 0, {
        message: "must be a positive number or -1 (unlimited)",
      })
      .optional(),
    maxToolRuntimeMs: z
      .number()
      .refine((n) => n === -1 || n > 0, {
        message: "must be a positive number or -1 (unlimited)",
      })
      .optional(),
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
    permissions: Guardrail.Permission.optional(),
    variant: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    budget: AgentBudget.optional(),
  });
  export type Definition = z.infer<typeof Definition>;
}
