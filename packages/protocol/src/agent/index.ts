import { z } from "zod";
import { Model } from "../model/index.js";
import { Policy } from "../policy/index.js";

export namespace AgentProfile {
  export const ModelRef = Model.Ref;
  export type ModelRef = Model.Ref;

  const budgetLimit = z
    .number()
    .int()
    .refine((n) => n === -1 || n > 0, {
      message: "must be a positive integer or -1 (unlimited)",
    });

  const budgetThreshold = z.number().gt(0).lt(1);
  export const DEFAULT_REASSURANCE_THRESHOLD = 0.6;
  export const DEFAULT_WARNING_THRESHOLD = 0.8;

  export const BudgetThresholdInput = z.object({
    warningThreshold: budgetThreshold.optional(),
    reassuranceThreshold: budgetThreshold.optional(),
  });
  export type BudgetThresholdInput = z.infer<typeof BudgetThresholdInput>;

  export const AgentBudget = z
    .object({
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
      warningThreshold: budgetThreshold.optional(),
      reassuranceThreshold: budgetThreshold.optional(),
    })
    .refine(
      (budget) =>
        (budget.reassuranceThreshold ?? DEFAULT_REASSURANCE_THRESHOLD) <
        (budget.warningThreshold ?? DEFAULT_WARNING_THRESHOLD),
      {
        path: ["reassuranceThreshold"],
        message: "must be less than warningThreshold",
      },
    );
  export type AgentBudget = z.infer<typeof AgentBudget>;

  export const Definition = z.object({
    name: z.string(),
    description: z.string(),
    systemPrompt: z.string().optional(),
    tools: z.string().array().default([]),
    model: ModelRef.optional(),
    permissions: Policy.Permission.optional(),
    variant: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    budget: AgentBudget.optional(),
  });
  export type Definition = z.infer<typeof Definition>;
}
